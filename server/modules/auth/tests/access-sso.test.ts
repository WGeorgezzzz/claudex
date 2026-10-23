import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { exchangeAccessIdentity } from '@/modules/auth/access-sso.service.js';
import { authSessionsDb, closeConnection, initializeDatabase, userDb } from '@/modules/database/index.js';

test('Access SSO validates identity, binds expiry, and cannot renew a revoked device', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claudex-sso-'));
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  closeConnection();
  Object.assign(process.env, {
    DATABASE_PATH: path.join(root, 'test.db'), CLOUDCLI_HOME: root,
    CLAUDEX_PRIVATE_GATE: '1', CLAUDEX_ACCESS_SSO_EMAIL: 'owner@example.com',
    CLAUDEX_PUBLIC_HOST: 'fixture.example.com', CLAUDEX_ACCESS_TEAM: 'https://fixture.cloudflareaccess.com',
    CLAUDEX_ACCESS_AUD: 'fixture-audience', CLAUDEX_ACCESS_EMAILS: 'owner@example.com,guest@example.com',
  });
  await writeFile(process.env.DATABASE_PATH!, '');
  await initializeDatabase();
  try {
    const user = userDb.createUser('local-owner', 'unused-password-hash');
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'fixture-key' };
    globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: process.env.CLAUDEX_ACCESS_TEAM, aud: ['fixture-audience'], email: 'owner@example.com', iat: now, exp: now + 3600 };
    const token = (overrides: Record<string, unknown> = {}) => {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-key' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ ...claims, ...overrides })).toString('base64url');
      return `${header}.${payload}.` + sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), pair.privateKey).toString('base64url');
    };
    const req = (assertion: string, extra: Record<string, string> = {}) => ({ headers: {
      host: 'fixture.example.com', origin: 'https://fixture.example.com', 'cf-access-jwt-assertion': assertion, ...extra,
    }, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
    // Legacy SSO binds the administrator even without an independent remote password.
    assert.equal((await exchangeAccessIdentity(req(token()))).user.id, user.id);
    authSessionsDb.configure(Number(user.id), 'remote-owner', 'unused', 'unused');
    const identity = await exchangeAccessIdentity(req(token()));
    assert.equal(identity.user.id, user.id);
    assert.equal(authSessionsDb.get(identity.authSessionId)?.expires_at, claims.exp * 1000);
    assert.equal((await exchangeAccessIdentity(req(token()))).authSessionId, identity.authSessionId);
    for (const bad of [token({ email: 'guest@example.com' }), token({ aud: ['other-app'] }), token({ iss: 'https://other.cloudflareaccess.com' }), token({ exp: now - 1 }), 'forged']) {
      await assert.rejects(exchangeAccessIdentity(req(bad)));
    }
    const member=userDb.createUser('member-sso','unused-password-hash');
    userDb.updateAccess(Number(member.id),path.join(root,'member'),[],'member@example.com',true);
    const memberToken=token({email:'member@example.com'});
    assert.equal((await exchangeAccessIdentity(req(memberToken))).user.id,member.id);
    userDb.updateAccess(Number(member.id),path.join(root,'member'),[],'member@example.com',false);
    await assert.rejects(exchangeAccessIdentity(req(memberToken)));
    const parts = token().split('.');
    const signature = Buffer.from(parts[2], 'base64url'); signature[0] ^= 1; parts[2] = signature.toString('base64url');
    await assert.rejects(exchangeAccessIdentity(req(parts.join('.'))));
    await assert.rejects(exchangeAccessIdentity(req(token(), { origin: 'https://evil.example' })));
    await assert.rejects(exchangeAccessIdentity(req(token(), { host: 'localhost:3001' })));
    authSessionsDb.revoke(Number(user.id), identity.authSessionId);
    await assert.rejects(exchangeAccessIdentity(req(token())), /revoked/);
    process.env.CLAUDEX_ACCESS_SSO_EMAIL = '';
    await assert.rejects(exchangeAccessIdentity(req(token())), /required/);
    process.env.CLAUDEX_ACCESS_SSO_EMAIL = 'owner@example.com';
    process.env.CLAUDEX_PRIVATE_GATE = '0';
    await assert.rejects(exchangeAccessIdentity(req(token())), /required/);
  } finally {
    closeConnection(); globalThis.fetch = originalFetch;
    for (const key of ['DATABASE_PATH', 'CLOUDCLI_HOME', 'CLAUDEX_PRIVATE_GATE', 'CLAUDEX_ACCESS_SSO_EMAIL', 'CLAUDEX_PUBLIC_HOST', 'CLAUDEX_ACCESS_TEAM', 'CLAUDEX_ACCESS_AUD', 'CLAUDEX_ACCESS_EMAILS']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});
