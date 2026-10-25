// @ts-nocheck -- JWT request augmentation is narrowed by Auth route contracts.
import { EventEmitter } from 'node:events';
import jwt from 'jsonwebtoken';

import { IS_PLATFORM } from '@/shared/index.js';
import { userDb, appConfigDb, authSessionsDb } from '@/modules/database/index.js';
import { isLocalRequest, requiresRemoteLogin } from '@/modules/auth/access-boundary.js';

import { withUserContext } from './user-context.js';

/** Auth routes and websocket ingress immediately disconnect revoked device sessions. */
export const authSessionEvents = new EventEmitter();
authSessionEvents.setMaxListeners(0);

// Use env var if set, otherwise auto-generate a unique secret per installation
// Resolve lazily: database ownership imports the auth barrel during module setup.
const jwtSecret = () => process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret();

// Server composition uses this optional API-wide key check before authenticated feature routes.
export const validateApiKey = (req, res, next) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }
  
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

// Server and Auth routes verify account and device ownership before entering feature services.
export const authenticateToken = async (req, res, next) => {
  // Preserve tokenless platform compatibility only for an actual single-account install.
  if (IS_PLATFORM && isLocalRequest(req) && !req.headers.authorization && !req.query.token && userDb.listUsers().length === 1) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        return res.status(500).json({ error: 'Platform mode: No user found in database' });
      }
      req.user = user;
      return withUserContext(user.id, () => next());
    } catch (error) {
      console.error('Platform mode error:', error);
      return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
    }
  }

  // Normal OSS JWT validation
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  // Also check query param for SSE endpoints (EventSource can't set headers)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    res.setHeader('X-Auth-Error', 'invalid-token');
    return res.status(401).json({
      error: 'Access denied. No token provided.',
      code: 'AUTH_TOKEN_INVALID',
    });
  }

  try {
    const decoded = jwt.verify(token, jwtSecret());
    const device = decoded.sid ? authSessionsDb.get(decoded.sid) : null;
    if (decoded.sid && (!device || device.user_id !== decoded.userId)) throw new Error('Device session revoked.');
    if (requiresRemoteLogin(req) && device?.kind !== 'remote') throw new Error('Remote password and MFA login required.');

    // Verify user still exists and is active
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      res.setHeader('X-Auth-Error', 'invalid-token');
      return res.status(401).json({
        error: 'Invalid token. User not found.',
        code: 'AUTH_TOKEN_INVALID',
      });
    }

    // Auto-refresh: if token is past halfway through its lifetime, issue a new one
    if (decoded.exp && decoded.iat) {
      const now = Math.floor(Date.now() / 1000);
      const halfLife = (decoded.exp - decoded.iat) / 2;
      if (now > decoded.iat + halfLife) {
        const newToken = generateToken({...user, authSessionId:decoded.sid, authKind:device?.kind});
        res.setHeader('X-Refreshed-Token', newToken);
      }
    }

    req.user = {...user, authSessionId:decoded.sid, authKind:device?.kind ?? 'legacy'};
    return withUserContext(user.id, () => next());
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.setHeader('X-Auth-Error', 'session-expired');
      return res.status(401).json({
        error: 'Session expired. Please log in again.',
        code: 'AUTH_TOKEN_EXPIRED',
      });
    }

    console.warn(
      'Token verification failed:',
      error instanceof Error ? error.message : String(error),
    );
    res.setHeader('X-Auth-Error', 'invalid-token');
    return res.status(401).json({
      error: 'Invalid token',
      code: 'AUTH_TOKEN_INVALID',
    });
  }
};

// Auth composition and local/remote login routes issue tokens bound to a revocable device session.
export const generateToken = (user) => {
  const sid=user.authSessionId || authSessionsDb.create(Number(user.id), user.authKind || 'password');
  const device=authSessionsDb.get(sid);
  if(!device || device.user_id!==Number(user.id))throw new Error('Device session is no longer active.');
  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
      sid
    },
    jwtSecret(),
    { expiresIn: Math.max(1,Math.floor((device.expires_at-Date.now())/1000)) }
  );
};

// WebSocket ingress reuses the same account/device lifetime validation as HTTP.
export const authenticateWebSocket = (token) => {
  // Multi-account platform sockets must carry an account-bound JWT too.
  if (IS_PLATFORM && !token && userDb.listUsers().length === 1) {
    try {
      const user = userDb.getFirstUser();
      if (user) {
        return { id: user.id, userId: user.id, username: user.username };
      }
      return null;
    } catch (error) {
      console.error('Platform mode WebSocket error:', error);
      return null;
    }
  }

  // Normal OSS JWT validation
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, jwtSecret());
    const device=decoded.sid?authSessionsDb.get(decoded.sid):null;
    if(decoded.sid&&(!device||device.user_id!==decoded.userId))return null;
    // Verify user actually exists in database (matches REST authenticateToken behavior)
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return null;
    }
    return { userId: user.id, username: user.username, authSessionId:decoded.sid, authKind:device?.kind ?? 'legacy',authExpiresAt:decoded.exp*1000 };
  } catch (error) {
    if (!(error instanceof jwt.TokenExpiredError)) {
      console.warn(
        'WebSocket token verification failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
    return null;
  }
};
