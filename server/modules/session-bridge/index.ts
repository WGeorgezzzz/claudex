export { sessionBridgeRoutes } from '@/modules/session-bridge/session-bridge.routes.js';
export { createSessionBridgeQuery } from '@/modules/session-bridge/session-bridge.tools.js';

// Authorization integration tests exercise bound MCP source identity through the public adapter.
export { executeSessionBridgeTool } from './session-bridge.tools.js';

export { createCodexSessionTool } from './session-bridge.tools.js';
export { sessionBridgeService } from './session-bridge.service.js';
