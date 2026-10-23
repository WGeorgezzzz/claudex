import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { isLocalRequest, validateAccessBoundary } from '@/modules/auth/access-boundary.js';
import { authSessionsDb, userDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/index.js';

/** Auth routes advertise SSO only for the explicitly configured private remote entry. */
export function isAccessSsoEnabled(req: IncomingMessage): boolean {
  return process.env.CLAUDEX_PRIVATE_GATE === '1'
    && Boolean(process.env.CLAUDEX_ACCESS_SSO_EMAIL?.trim())
    && !isLocalRequest(req);
}

/** Auth exchanges a verified Access identity for the configured owner's revocable session. */
export async function exchangeAccessIdentity(req: IncomingMessage) {
  if (!isAccessSsoEnabled(req) || !await validateAccessBoundary(req)) {
    throw new AppError('Verified private access identity required.', { statusCode: 403 });
  }
  // Parse claims only after the full signature, issuer, audience, expiry and origin checks.
  const assertion = req.headers['cf-access-jwt-assertion'] as string;
  const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString()) as { email: string; exp: number };
  if (claims.email.toLowerCase() !== process.env.CLAUDEX_ACCESS_SSO_EMAIL!.trim().toLowerCase()) {
    throw new AppError('This identity is not mapped to the workspace owner.', { statusCode: 403 });
  }
  const remote = authSessionsDb.remote();
  const user = remote && userDb.getUserById(remote.user_id);
  if (!user) throw new AppError('Configure the workspace owner locally first.', { statusCode: 409 });
  // One session per signed Access credential: refresh cannot silently undo device revocation.
  const id = 'access-' + createHash('sha256').update(assertion).digest('hex');
  const expires = Math.min(claims.exp * 1000, Date.now() + 30 * 86400000);
  authSessionsDb.createAccessSession(id, user.id, expires);
  const session = authSessionsDb.get(id);
  if (!session || session.user_id !== user.id) {
    throw new AppError('This device session was revoked. Sign out of Cloudflare and sign in again.', { statusCode: 401 });
  }
  return { user, authSessionId: id };
}
