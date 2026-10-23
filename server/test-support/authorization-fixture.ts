import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, after } from 'node:test';
import type { RequestHandler } from 'express';
import { closeConnection, initializeDatabase, getConnection, userDb } from '@/modules/database/index.js';

let userId = 0;
/** Route and PTY regression tests use a disposable authenticated administrator, never a production account. */
export function installAuthorizationFixture(): void {
  before(async () => {
    closeConnection();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-authorization-fixture-'));
    process.env.DATABASE_PATH = path.join(root, 'test.db');
    fs.closeSync(fs.openSync(process.env.DATABASE_PATH, 'a'));
    await initializeDatabase();
    userId = Number(userDb.createUser('authorization-test-admin', 'unused').id);
    getConnection().prepare('INSERT INTO projects(project_id,project_path,custom_project_name) VALUES (?,?,?)').run('project-1', path.join(root, 'project'), 'Test');
  });
  after(() => closeConnection());
}
/** HTTP transport tests establish the same req.user contract as the production authentication middleware. */
export const authenticateTestRequest: RequestHandler = (req, _res, next) => {
  (req as typeof req & {user: {id: number; role: string}}).user = {id: userId, role: 'admin'};
  next();
};
/** PTY regression tests pass the verified handshake account through the public numeric identity contract. */
export function testUserId(): number { return userId; }
