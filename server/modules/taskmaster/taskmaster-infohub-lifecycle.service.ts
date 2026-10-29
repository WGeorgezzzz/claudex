import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Info-hub sync composition and isolated tests use an explicitly requested, single-flight lifecycle. */
export function createInfohubLifecycle(deps: {
  probe: () => Promise<unknown>;
  launch: () => Promise<{ pid: number; stop: () => Promise<void> }>;
  collect: () => Promise<unknown>;
  reconcile: (user: number) => Promise<{ online: boolean; error: string | null }>;
  isBusy?: () => boolean;
  now?: () => number;
}) {
  const now = deps.now || Date.now;
  let owned: Awaited<ReturnType<typeof deps.launch>> | undefined;
  let pending: Promise<void> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleMinutes = 10;
  let state = { phase: 'stopped', running: false, owned: false, pid: null as number | null,
    startedAt: null as string | null, lastActivityAt: null as string | null,
    idleDeadline: null as string | null, error: null as string | null, progress: { completed: 0, total: 3 } };
  const arm = () => {
    clearTimeout(idleTimer);
    if (!owned || pending) return;
    const remaining = Math.max(0, Date.parse(state.lastActivityAt!) + idleMinutes * 60000 - now());
    state.idleDeadline = new Date(now() + remaining).toISOString();
    idleTimer = setTimeout(() => { void stop().catch(error => { state.error = String(error); }); }, remaining);
    idleTimer.unref();
  };
  const stop = async () => {
    if (pending || deps.isBusy?.()) {
      clearTimeout(idleTimer);
      idleTimer=setTimeout(()=>{void stop().catch(error=>{state.error=String(error);});},1000);idleTimer.unref();
      return; // Never interrupt a collection or a reconciliation write.
    }
    clearTimeout(idleTimer);
    if (owned) await owned.stop(); // The launcher signals only its own interpreter, never a PID tree.
    owned = undefined;
    state = { ...state, phase: 'stopped', running: false, owned: false, pid: null, idleDeadline: null };
  };
  return {
    snapshot: () => ({ ...state, progress: { ...state.progress }, idleMinutes }),
    configure(minutes: number) { idleMinutes = minutes; arm(); return { idleMinutes }; },
    active: () => state.running,
    busy: () => !!pending,
    stop,
    start(user: number) {
      if (pending) return this.snapshot();
      clearTimeout(idleTimer);
      state = { ...state, running: true, phase: 'starting', error: null, idleDeadline: null, progress: { completed: 0, total: 3 } };
      pending = (async () => {
        try {
          try { await deps.probe(); }
          catch (cause) {
            if ((cause as {statusCode?:number;name?:string}).statusCode || (cause as Error).name==='TimeoutError') throw cause;
            // An earlier owned interpreter may still be alive after an API failure; never launch a duplicate.
            if (owned) throw Error('信息看板进程尚未退出但 API 不可用，请等待空闲退出后重试');
            owned = await deps.launch();
            state.owned = true; state.pid = owned.pid;
            let ready = false;
            for (let attempt = 0; attempt < 60; attempt++) {
              try { await deps.probe(); ready = true; break; } catch(cause) { if((cause as {statusCode?:number}).statusCode)throw cause;await new Promise(resolve => setTimeout(resolve, 500)); }
            }
            if (!ready) throw Error('信息看板启动超时，请检查配置、端口和启动日志');
          }
          state.startedAt ||= new Date(now()).toISOString();
          state.phase = 'collecting'; state.progress.completed = 1;
          await deps.collect();
          state.phase = 'syncing'; state.progress.completed = 2;
          const result = await deps.reconcile(user);
          if (!result.online) throw Error(result.error || '任务同步失败');
          state.phase = 'idle'; state.progress.completed = 3;
        } catch (error) { state.phase = 'error'; state.running=!!owned||state.progress.completed>=1||!!(error as {statusCode?:number}).statusCode;state.error = error instanceof Error ? error.message : String(error); }
        finally { state.lastActivityAt = new Date(now()).toISOString(); pending = undefined; arm(); }
      })();
      return this.snapshot();
    },
    async settled() { await pending; return this.snapshot(); },
  };
}

/** Lifecycle composition uses a private control directory; only this newly launched Python observes its stop signal. */
export async function launchInfohubProcess() {
  const root = path.resolve(process.env.INFOHUB_ROOT || 'D:/embodied/info-hub');
  const python = process.env.INFOHUB_PYTHON || path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nexagent-infohub-'));
  const pidFile = path.join(directory, 'pid');
  const stopFile = path.join(directory, 'stop');
  const exitFile = path.join(directory, 'exited');
  // A control thread exits its own PID only. No taskkill, process-name matching, browser or business-session cleanup.
  const script = `import os,sys,time,threading,runpy,pathlib\npid,stop,exited,log=sys.argv[1:5]\nsys.argv=['infohub']+sys.argv[5:]\nsys.path.insert(0,os.getcwd())\nsys.stdout=open(log,'a',encoding='utf-8',buffering=1)\nsys.stderr=sys.stdout\npathlib.Path(pid).write_text(str(os.getpid()))\ndef watch():\n while not pathlib.Path(stop).exists(): time.sleep(0.2)\n pathlib.Path(exited).write_text('stopped')\n os._exit(0)\nthreading.Thread(target=watch,daemon=True).start()\ntry: runpy.run_module('infohub',run_name='__main__')\nfinally: pathlib.Path(exited).write_text('exited')\n`;
  const scriptFile=path.join(directory,'serve.py');await writeFile(scriptFile,script);
  const log = await open(path.join(directory, 'startup.log'), 'a');
  const args = ['-u', scriptFile, pidFile, stopFile, exitFile, path.join(directory,'startup.log'),
    ...(process.env.INFOHUB_CONFIG_PATH ? ['--config', path.resolve(process.env.INFOHUB_CONFIG_PATH)] : []), 'serve'];
  let launchError: Error | undefined;
  const child = spawn(process.platform === 'win32' ? 'conhost.exe' : python,
    process.platform === 'win32' ? ['--headless', python, ...args] : args,
    // ConPTY closes the client when its input is already EOF; retain a private pipe until our interpreter exits.
    { cwd: root, detached: true, windowsHide: true, stdio: ['pipe', log.fd, log.fd] });
  child.once('error', error => { launchError = error; }); child.unref();
  await log.close();
  for (let attempt = 0; attempt < 50; attempt++) {
    if (launchError) throw launchError;
    try {
      const pid = Number(await readFile(pidFile, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) return { pid, stop: async () => {
        await writeFile(stopFile, 'stop');
        for (let check = 0; check < 50; check++) {
          try { await readFile(exitFile); child.stdin?.destroy();return; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
        }
        throw Error('等待自有信息看板进程退出超时：' + directory);
      } };
    } catch { /* Wait for the interpreter's ownership handshake. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await writeFile(stopFile, 'stop');
  child.stdin?.destroy();
  throw Error('无法启动信息看板，请检查 Python 环境；日志：' + directory);
}
