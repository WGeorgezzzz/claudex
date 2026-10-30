import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { SpawnOptions, SpawnedProcess, ModelInfo } from '@anthropic-ai/claude-agent-sdk';

import { createClaudeLaunchEnvironment } from '@/shared/utils.js';
import { getCurrentUserContext } from '@/modules/auth/index.js';

// Supervised turns keep their native CLI in a separate Windows process group.
export function spawnSupervisedClaude(options: SpawnOptions): SpawnedProcess {
  return spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal,
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform === 'win32' });
}

// Model discovery in a durable owner is a control-only CLI exchange. It must
// not construct then abort an SDK query alongside the actual running turn.
export function loadSupervisedClaudeModels(executable: string, cwd: string): Promise<ModelInfo[]> {
  return new Promise((resolve, reject) => {
    const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
    const script = /\.[cm]?js$/i.test(executable);
    const child = spawn(script ? process.execPath : executable, script ? [executable, ...args] : args,
      { cwd, env: createClaudeLaunchEnvironment(getCurrentUserContext()?.env || process.env, executable),
        windowsHide: true, detached: process.platform === 'win32', stdio: ['pipe','pipe','pipe'] });
    let settled = false;
    let closed = false;
    let afterClose: (() => void) | undefined;
    const timer = setTimeout(() => finish(undefined, new Error('Claude model control handshake timed out')), 45000);
    const reader = readline.createInterface({ input: child.stdout });
    const finish = (models?: ModelInfo[], error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); reader.close();
      // Do not overlap a closing discovery CLI with the actual SDK turn. A
      // control reply is not proof that the native process/job has exited.
      let kill: NodeJS.Timeout | undefined;
      const done = () => { clearTimeout(kill); if (error) reject(error); else resolve(models!); };
      if (closed) done();
      else { afterClose = done; child.stdin.end(); kill = setTimeout(() => child.kill(), 2000); kill.unref(); }
    };
    reader.on('line', line => {
      try {
        const data = JSON.parse(line);
        if (data.type === 'control_response' && data.response?.request_id === 'supervisor-models') {
          const models = data.response?.response?.models;
          if (Array.isArray(models) && models.length) finish(models);
          else finish(undefined, new Error('Claude control response omitted model definitions'));
        }
      } catch { /* Only complete control JSON is part of this protocol. */ }
    });
    child.stderr.resume(); child.stdin.on('error', error => finish(undefined,error));
    child.once('error', error => finish(undefined,error));
    child.once('close', code => { closed = true; if (afterClose) afterClose(); else finish(undefined,new Error('Claude model control exited '+code)); });
    child.stdin.write(JSON.stringify({type:'control_request',request_id:'supervisor-models',request:{subtype:'initialize'}})+'\n');
  });
}
