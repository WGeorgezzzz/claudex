import type { RequestHandler } from 'express';
import { AppError } from '@/shared/index.js';
import { getCurrentUserContext } from './user-context.js';

/** System, Plugins and Providers protect host-wide configuration shared by all accounts. */
export const requireSharedResourceAdministrator: RequestHandler = (request, _response, next) => {
  const identity = (request as typeof request & { user?: { role?: string } }).user;
  const role = getCurrentUserContext()?.role ?? identity?.role;
  // Routers are mounted behind authentication. Unscoped internal callers retain
  // the legacy administrator behavior; authenticated members cannot write shared state.
  if (role === 'member' || (identity && role !== 'admin')) {
    next(new AppError('此操作需要管理员权限。', { statusCode: 403, code: 'ADMIN_REQUIRED' }));
    return;
  }
  next();
};
