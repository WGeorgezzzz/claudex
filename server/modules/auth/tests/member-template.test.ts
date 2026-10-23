import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Only a disposable database and configuration tree are touched.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-member-template-'));
process.env.DATABASE_PATH = path.join(root, 'test.db');
process.env.CLAUDEX_USER_CONFIG_ROOT = path.join(root, 'users');
process.env.CLAUDEX_USERS_WORK_ROOT = path.join(root, 'work');
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'admin-claude');
process.env.CODEX_HOME = path.join(root, 'admin-codex');
for (const dir of [process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), '{"auth_mode":"chatgpt"}');
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'model = "admin"\n');

const db = await import('@/modules/database/index.js');
const auth = await import('@/modules/auth/index.js');
const { userManagementService } = await import('@/modules/auth/user-management.service.js');

await db.initializeDatabase();
const admin = db.userDb.createUser('owner', 'unused-hash');
db.getConnection().prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
const template = path.join(root, 'member-template');

test('new members skip onboarding and inherit administrator Codex without a template', async () => {
  const { user } = await userManagementService.create(Number(admin.id), { username: 'plain', password: 'PLAIN-PASS' }) as { user: { id: number } };
  assert.equal(db.userDb.hasCompletedOnboarding(user.id), true);
  const context = auth.getUserContext(user.id);
  assert.equal(fs.readFileSync(path.join(context.codexHome, 'config.toml'), 'utf8'), 'model = "admin"\n');
  assert.equal(fs.readFileSync(path.join(context.codexHome, 'auth.json'), 'utf8'), '{"auth_mode":"chatgpt"}');
  assert.ok(!fs.existsSync(path.join(context.claudeConfigDir, 'CLAUDE.md')));
});

test('member template supplies CLAUDE.md and Codex config while auth.json stays private', async () => {
  fs.mkdirSync(path.join(template, 'claude'), { recursive: true });
  fs.mkdirSync(path.join(template, 'codex'), { recursive: true });
  fs.writeFileSync(path.join(template, 'claude', 'CLAUDE.md'), 'plan first');
  fs.writeFileSync(path.join(template, 'codex', 'config.toml'), 'model = "relay"\n');
  const { user } = await userManagementService.create(Number(admin.id), { username: 'templated', password: 'TEMPLATED' }) as { user: { id: number } };
  let context = auth.getUserContext(user.id);
  assert.equal(fs.readFileSync(path.join(context.claudeConfigDir, 'CLAUDE.md'), 'utf8'), 'plan first');
  assert.equal(fs.readFileSync(path.join(context.codexHome, 'config.toml'), 'utf8'), 'model = "relay"\n');
  assert.ok(!fs.existsSync(path.join(context.codexHome, 'auth.json')));
  fs.writeFileSync(path.join(context.codexHome, 'auth.json'), '{"OPENAI_API_KEY":"member"}');
  fs.writeFileSync(path.join(template, 'claude', 'CLAUDE.md'), 'plan first, v2');
  fs.writeFileSync(path.join(process.env.CODEX_HOME!, 'auth.json'), '{"auth_mode":"chatgpt","refreshed":true}');
  context = auth.getUserContext(user.id);
  assert.equal(fs.readFileSync(path.join(context.claudeConfigDir, 'CLAUDE.md'), 'utf8'), 'plan first, v2');
  assert.equal(fs.readFileSync(path.join(context.codexHome, 'auth.json'), 'utf8'), '{"OPENAI_API_KEY":"member"}');
  const shared = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDEX_USER_CONFIG_ROOT!, String(user.id), 'shared-config.json'), 'utf8'));
  assert.equal(shared['codex/auth.json'], 'private');
});
