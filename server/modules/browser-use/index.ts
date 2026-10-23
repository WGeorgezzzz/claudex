/**
 * Lazily starts the Browser Use MCP stdio entrypoint. Keeping this import lazy
 * ensures the entrypoint loads environment configuration before its runtime is
 * evaluated.
 */
export async function startBrowserUseMcp(): Promise<void> {
  await import('./browser-use-mcp.js');
}

// getBrowserUseRuntime: used by Browser Use services and environment-mode regression coverage.
export { getBrowserUseRuntime } from './browser-use-runtime.js';

// Authorization integration tests and server composition exercise the user-bound browser surface.
export { browserUseService } from './browser-use.service.js';
export { default as browserUseRoutes } from './browser-use.routes.js';
export { default as browserUseMcpRoutes } from './browser-use-mcp.routes.js';
