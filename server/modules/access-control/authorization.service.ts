import path from 'node:path';
import type { RequestHandler } from 'express';
import { assertUserPath, withUserContext, getCurrentUserContext } from '@/modules/auth/index.js';
import { sessionsDb, getSessionOwnerId } from '@/modules/database/index.js';
import { AppError, requireAuthenticatedUserId } from '@/shared/index.js';

/** Browser and filesystem services require a server-bound execution identity. */
export function requireContextUserId(): number {
  const id = Number(getCurrentUserContext()?.userId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError('请先登录。', { statusCode: 401 });
  return id;
}

/** Filesystem services validate resolved targets, including junctions, immediately before use. */
export function assertContextPath(target: string): void {
  assertUserPath(requireContextUserId(), target);
}

/** Bridge, monitor and terminal entrypoints enforce ownership even for administrators. */
export function assertOwnedSession(userId: number, sessionId: string) {
  if (getSessionOwnerId(sessionId) !== userId) throw new AppError('无权访问此会话。', { statusCode: 403 });
  const session = withUserContext(userId, () => sessionsDb.getSessionById(sessionId));
  if (!session) throw new AppError('会话不存在。', { statusCode: 404 });
  return session;
}

/** Feature routers bind async work to the identity established by account authentication. */
export const userContextMiddleware: RequestHandler = (req, _res, next) => {
  try { withUserContext(requireAuthenticatedUserId(req), () => next()); } catch (error) { next(error); }
};

/** Git/commands routers validate transport paths before legacy error handlers execute. */
export function authorizePaths(select: (req: Parameters<RequestHandler>[0]) => string[]): RequestHandler {
  return (req, _res, next) => {
    try {
      const userId = requireAuthenticatedUserId(req);
      for (const target of select(req)) assertUserPath(userId, path.resolve(target));
      next();
    } catch (error) { next(error); }
  };
}

/** File-tree and Taskmaster register this parameter guard before project-scoped routes. */
export function authorizeProjectParameter(resolve: (id: string) => string | null) {
  return (req: Parameters<RequestHandler>[0], _res: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2], id: string) => {
    try {
      const target = resolve(id);
      if (!target) throw new AppError('项目不存在。', { statusCode: 404 });
      assertUserPath(requireAuthenticatedUserId(req), target);
      next();
    } catch (error) { next(error); }
  };
}
