import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';

if (process.env.CI !== 'true') throw Error('Run isolated npm installation on a disposable CI runner.');
const manifest = path.resolve(process.argv[2]);
const pack = JSON.parse(await fs.readFile(manifest, 'utf8'))[0];
assert.equal(pack.name, 'nexagent'); assert.equal(pack.version, '1.0.0');
for (const name of ['LICENSE', 'NOTICE', 'dist-server/server/modules/cli/cli.js', 'dist/index.html']) assert(pack.files.some(file => file.path === name), `Missing ${name}`);
assert(!pack.files.some(file => /(?:^|\/)(?:tests|\.env|auth\.db)(?:\/|$)/.test(file.path)));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexagent-npm-'));
const home = path.join(directory, 'home'); await fs.mkdir(home);
const archive = path.join(path.dirname(manifest), pack.filename);
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|CODEX|CLOUDCLI|NEXAGENT|VITE_|DATABASE_PATH|JWT_SECRET|API_KEY)/i.test(key)));
Object.assign(environment, { HOME: home, USERPROFILE: home, CLOUDCLI_HOME: path.join(home, '.cloudcli'), DATABASE_PATH: path.join(home, 'auth.db'), CLAUDEX_PASSIVE_INSTANCE: '1', HOST: '127.0.0.1' });
execFileSync('npm', ['install', '--prefix', directory, '--omit=dev', '--no-audit', '--no-fund', archive], { env: environment, stdio: 'inherit' });
const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const log = await fs.open(path.join(directory, 'server.log'), 'a');
const child = spawn('npx', ['--no-install', 'nexagent', 'start', '--port', String(port)], { cwd: directory, env: environment, detached: true, stdio: ['ignore', log.fd, log.fd] });
let base = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try { ready = (await fetch(base + '/health')).ok; } catch {}
    if (ready) break; await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert(ready, 'npm archive server must start');
  assert.equal((await fetch(base + '/api/auth/status').then(response => response.json())).needsSetup, true);
  const register = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'demo-admin', password: 'demo-password-for-ci' }) });
  assert.equal(register.status, 200);
  const { token, user } = await register.json(); assert.equal(user.role, 'admin');
  const authorized = { headers: { Authorization: `Bearer ${token}` } };
  const quota = await fetch(base + '/api/quota', authorized).then(response => response.json());
  assert.equal(quota.key.data.mode, 'unconfigured'); assert.equal(quota.key.error, null);
  assert.equal((await fetch(base + '/api/monitors', authorized)).status, 200);
  assert.equal((await fetch(base + '/api/monitors')).status, 401);
  assert.match(await fetch(base).then(response => response.text()), /Drover/);
  const result = { passed: true, package: `${pack.name}@${pack.version}`, shasum: pack.shasum, port, freshSetup: true, adminCreated: true, authenticatedBusinessApi: 200, anonymous: 401, relayUnconfigured: true, npx: '--no-install nexagent start' };
  await fs.writeFile('release/workbench/npm-smoke.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
  await log.close();
}
