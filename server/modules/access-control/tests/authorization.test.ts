import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { WebSocket } from 'ws';

// These checks only open a disposable task-local database and configuration roots.
const root = path.resolve('..', 'evidence', 'authorization', `run-${Date.now()}-${process.pid}`);
fs.mkdirSync(root, { recursive: true });
process.env.DATABASE_PATH = path.join(root, `authorization-${process.pid}.db`);
fs.closeSync(fs.openSync(process.env.DATABASE_PATH, 'a'));
process.env.CLAUDEX_USER_CONFIG_ROOT = path.join(root, 'configs');
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'admin-claude');
process.env.CODEX_HOME = path.join(root, 'admin-codex');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });

const db = await import('@/modules/database/index.js');
const auth = await import('@/modules/auth/index.js');
const access = await import('@/modules/access-control/index.js');
const { fileTreeRoutes } = await import('@/modules/file-tree/index.js');
const { createGitModule } = await import('@/modules/git/index.js');
const { commandsRoutes } = await import('@/modules/commands/index.js');
const { taskmasterRoutes } = await import('@/modules/taskmaster/index.js');
const { sessionBridgeRoutes } = await import('@/modules/session-bridge/index.js');
const { monitorsRoutes } = await import('@/modules/monitors/index.js');
const { browserUseService } = await import('@/modules/browser-use/index.js');
const { browserUseRoutes: browserRoutes } = await import('@/modules/browser-use/index.js');
const { browserUseMcpRoutes: browserMcpRoutes } = await import('@/modules/browser-use/index.js');
const { handleShellConnection } = await import('@/modules/websocket/index.js');
const { executeSessionBridgeTool } = await import('@/modules/session-bridge/index.js');

await db.initializeDatabase();
const sql = db.getConnection();
const users = ['admin', 'A', 'B'].map(name => {
  const workRoot = path.join(root, name);
  fs.mkdirSync(workRoot, { recursive: true });
  const id = Number(db.userDb.createUser(name, 'unused-hash').id);
  sql.prepare('UPDATE users SET role=?,work_root=?,allowed_folders=? WHERE id=?').run(name === 'admin' ? 'admin' : 'member', workRoot, '[]', id);
  return { id, workRoot };
});
const [admin, a, b] = users;
const projects = users.map(user => auth.withUserContext(user.id, () => {
  fs.writeFileSync(path.join(user.workRoot, 'private.txt'), `secret-${user.id}`);
  const project = db.projectsDb.createProjectPath(user.workRoot).project!;
  db.sessionsDb.createAppSession(`session-${user.id}`, 'claude', user.workRoot, `title-${user.id}`);
  return project;
}));
const noProvider = async () => { throw new Error('Provider must not start for these checks.'); };
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as typeof req & { user: { id: number } }).user = { id: Number(req.headers['x-test-user'] ?? a.id) };
  next();
});
app.use('/files', fileTreeRoutes);
app.use('/git', createGitModule({ queryClaude: noProvider, queryCursor: noProvider }));
app.use('/commands', commandsRoutes);
app.use('/taskmaster', taskmasterRoutes);
app.use('/bridge', sessionBridgeRoutes);
app.use('/monitors', monitorsRoutes);
app.use('/browser', browserRoutes);
app.use('/browser-mcp', browserMcpRoutes);
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const err = error as { statusCode?: number; message?: string };
  res.status(err.statusCode ?? 500).json({ error: err.message });
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
async function request(userId: number, url: string, body?: unknown) {
  return fetch(base + url, { method: body ? 'POST' : 'GET', headers: { 'x-test-user': String(userId), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

test('authorization HTTP surfaces isolate paths, sessions, bridge tools, monitors and browser capabilities', async () => {
  try {
    const own = await request(a.id, `/files/projects/${projects[1].project_id}/file?filePath=private.txt`);
    assert.equal(own.status, 200); assert.match(await own.text(), /secret-/);
    const checks: Array<[string, unknown?]> = [
      [`/files/browse-filesystem?path=${encodeURIComponent(a.workRoot)}`],
      [`/files/projects/${projects[1].project_id}/file?filePath=private.txt`],
      ['/files/create-folder', { path: path.join(a.workRoot, 'forbidden-new') }],
      [`/git/status?project=${projects[1].project_id}`],
      ['/git/init', { project: projects[1].project_id }],
      ['/commands/list', { projectPath: a.workRoot }],
      ['/commands/execute', { commandName: 'x', commandPath: path.join(a.workRoot, 'private.txt'), context: { projectPath: a.workRoot } }],
      [`/taskmaster/tasks/${projects[1].project_id}`],
      [`/bridge/sessions/session-${a.id}`],
      ['/bridge/send', { sourceSessionId: `session-${b.id}`, sessionId: `session-${a.id}`, content: 'forbidden' }],
      ['/monitors', { sessionId: `session-${a.id}`, name: 'bad', content: 'bad', intervalMinutes: 1 }],
    ];
    for (const [url, body] of checks) {
      const response = await request(b.id, url, body);
      assert.ok([403, 404].includes(response.status), `${url}: ${response.status} ${await response.text()}`);
    }
    const listing = await request(b.id, '/bridge/sessions');
    const listingText = await listing.text();
    assert.equal(listing.status, 200); assert.ok(listingText.includes(`session-${b.id}`)); assert.ok(!listingText.includes(`session-${a.id}`));
    await assert.rejects(executeSessionBridgeTool({ userId: b.id, sessionId: `session-${b.id}`, autonomous: false, planMode: false }, { action: 'read', sessionId: `session-${a.id}` }), /无权/);
    await assert.rejects(executeSessionBridgeTool({ userId: b.id, sessionId: `session-${a.id}`, autonomous: false, planMode: false }, { action: 'list' }), /无权/);
    assert.throws(() => access.assertOwnedSession(admin.id, `session-${a.id}`), /无权/);

    const link = path.join(b.workRoot, 'escape');
    fs.symlinkSync(a.workRoot, link, 'junction');
    const junctionRead = await request(b.id, `/files/projects/${projects[2].project_id}/file?filePath=escape/private.txt`);
    assert.equal(junctionRead.status, 403);
    const traversal = await request(b.id, `/files/projects/${projects[2].project_id}/file?filePath=../A/private.txt`);
    assert.equal(traversal.status, 403);

    const tokenA = access.issueBrowserMcpToken(a.id), tokenB = access.issueBrowserMcpToken(b.id);
    assert.notEqual(tokenA, tokenB);
    assert.equal(browserUseService.resolveMcpUserId(tokenA), a.id);
    assert.equal(browserUseService.resolveMcpUserId(tokenA.replace(/^\d+/, String(b.id))), null);
    sql.prepare('UPDATE users SET is_active=0 WHERE id=?').run(b.id);
    assert.equal(browserUseService.resolveMcpUserId(tokenB), null);
    sql.prepare('UPDATE users SET is_active=1 WHERE id=?').run(b.id);
    const invalidToken = await fetch(base + '/browser-mcp/tools/browser_list_sessions', { method: 'POST', headers: { authorization: 'Bearer forged', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(invalidToken.status, 401);
    const sessionsB = await fetch(base + '/browser-mcp/tools/browser_list_sessions', { method: 'POST', headers: { authorization: `Bearer ${tokenB}`, 'content-type': 'application/json' }, body: JSON.stringify({ userId: a.id }) });
    assert.equal(sessionsB.status, 200);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('PTY initialization binds cwd, environment, resume identity and cache key to handshake account', () => {
  const spawned: Array<{ env?: Record<string, string | undefined> }> = [];
  const ptys: Array<{ emitExit(): void; kill(): void }> = [];
  function socket() {
    const ws = new EventEmitter() as EventEmitter & { readyState: number; send(data: string): void; close(): void; frames: string[] };
    ws.readyState = WebSocket.OPEN; ws.frames = []; ws.send = data => ws.frames.push(data); ws.close = () => undefined;
    return ws;
  }
  const deps = {
    resolveProviderSessionId: () => null,
    spawnPty: (_shell: unknown, _args: unknown, options: typeof spawned[number]) => {
      spawned.push(options); let onExit: (event: { exitCode: number }) => void = () => undefined;
      const pty = { onData() {}, onExit(fn: (event: { exitCode: number }) => void) { onExit = fn; }, emitExit() { onExit({ exitCode: 0 }); }, write() {}, resize() {}, kill() {} };
      ptys.push(pty); return pty as never;
    },
  };
  const first = socket(), second = socket(), denied = socket();
  // Both users may use the same authorized cwd, but must receive different processes.
  sql.prepare('UPDATE users SET allowed_folders=? WHERE id=?').run(JSON.stringify([a.workRoot]), b.id);
  handleShellConnection(first as never, deps as never, a.id);
  handleShellConnection(second as never, deps as never, b.id);
  const init = JSON.stringify({ type: 'init', projectPath: a.workRoot, provider: 'plain-shell', isPlainShell: true });
  first.emit('message', init); second.emit('message', init);
  assert.equal(spawned.length, 2);
  assert.notEqual(spawned[0].env?.CLAUDE_CONFIG_DIR, spawned[1].env?.CLAUDE_CONFIG_DIR);
  assert.notEqual(spawned[0].env?.CODEX_HOME, spawned[1].env?.CODEX_HOME);
  handleShellConnection(denied as never, deps as never, b.id);
  denied.emit('message', JSON.stringify({ type: 'init', projectPath: a.workRoot, sessionId: `session-${a.id}`, hasSession: true }));
  assert.equal(spawned.length, 2);
  for (const pty of ptys) pty.emitExit();
});

test.after(() => db.closeConnection());
