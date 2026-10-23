// authRoutes: used by the server entrypoint to mount public authentication endpoints.
export { authRoutes } from './auth.module.js';

// authenticateToken: used by the server entrypoint to protect authenticated API modules.
export { authenticateToken } from './auth.middleware.js';
// authenticateWebSocket: used by WebSocket setup to verify connection tokens.
export { authenticateWebSocket } from './auth.middleware.js';
// validateApiKey: used by the server entrypoint for optional API-wide key validation.
export { validateApiKey } from './auth.middleware.js';
export { authSessionEvents, generateToken } from './auth.middleware.js';
export { accessBoundaryMiddleware, validateAccessBoundary, isLocalRequest } from '@/modules/auth/access-boundary.js';
export { initializeLocalIdentity } from '@/modules/auth/local-identity.service.js';
// System, Plugins and Providers restrict host-wide shared resources to administrators.
export { requireSharedResourceAdministrator } from './shared-resource-access.service.js';

// Runtime, filesystem and WebSocket consumers share isolated user configuration.
export { getUserContext, assertUserPath, withUserContext, getCurrentUserContext } from './user-context.js';
