import { spawn, type ChildProcess } from 'node:child_process';

type Dependencies = {
  spawn: typeof spawn;
  retryMs: number;
  onAddress?: (url: string, previous: string | null) => void;
};

/** Remote Access owns a single hidden tunnel child, generation-safe shutdown and bounded reconnect backoff; tests inject its process transport. */
export class TunnelSupervisor {
  state: { phase: string; url: string | null; attempts: number; error: string | null } = { phase: 'stopped', url: null, attempts: 0, error: null };
  private child?: ChildProcess;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private dependencies: Dependencies;
  constructor(options: Partial<Dependencies> = {}) { this.dependencies = { spawn, retryMs: 2000, ...options }; }
  start(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
    this.stop();
    const generation = this.generation;
    const launch = () => {
      if (generation !== this.generation) return;
      this.state.phase = this.state.attempts ? 'reconnecting' : 'connecting';
      this.state.error = null;
      let output = '';
      const child = this.dependencies.spawn(command, args, { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      const data = (chunk: Buffer) => {
        if (generation !== this.generation) return;
        output = (output + chunk.toString()).slice(-16000).replace(/\x1b\[[0-9;]*m/g, '');
        const matches = output.match(/https:\/\/[a-zA-Z0-9.-]+(?::\d+)?(?:\/)?/g) ?? [];
        const url = matches.find(value => /\.(trycloudflare\.com|ts\.net)(?::\d+)?\/?$/.test(value)
          || /-\d+\.[a-z0-9-]+\.devtunnels\.ms\/?$/i.test(value));
        if (url) {
          const previous = this.state.url;
          this.state = { phase: 'running', url: url.replace(/\/$/, ''), attempts: 0, error: null };
          if (url.replace(/\/$/, '') !== previous) this.dependencies.onAddress?.(this.state.url!, previous);
        }
      };
      child.stdout?.on('data', data); child.stderr?.on('data', data);
      let ended = false;
      const retry = () => {
        if (ended || generation !== this.generation) return;
        ended = true; this.child = undefined;
        this.state.phase = 'reconnecting'; this.state.error = '连接中断，正在重连'; this.state.attempts++;
        this.timer = setTimeout(launch, Math.min(60000, this.dependencies.retryMs * 2 ** Math.min(this.state.attempts - 1, 5)));
        this.timer.unref();
      };
      child.once('error', retry); child.once('close', retry);
    };
    launch();
  }
  stop() {
    this.generation++; clearTimeout(this.timer);
    const child = this.child; this.child = undefined;
    child?.kill();
    if (child) { const forced = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000); forced.unref(); }
    this.state = { phase: 'stopped', url: null, attempts: 0, error: null };
  }
}
