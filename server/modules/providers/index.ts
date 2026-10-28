export { sessionSynchronizerService } from './services/session-synchronizer.service.js';
export { providerSkillsService } from './services/skills.service.js';
export { providerMcpService } from './services/mcp.service.js';
export { providerRuntimeService } from './services/provider-runtime.service.js';
export { providerRegistry } from './provider.registry.js';
// Server composition runs local program discovery after database initialization.
export { initializeAgentDiscovery } from './services/agent-discovery.service.js';

// providerModelsService: used by Commands to list models and resolve the active session model.
export { providerModelsService } from './services/provider-models.service.js';

// sessionsService: used by the websocket module's chat gateway to resolve an
// edited message's resume point, which only the providers module can read.
export { sessionsService } from './services/sessions.service.js';

export { initializeSessionsWatcher } from './services/sessions-watcher.service.js';
export { closeSessionsWatcher } from './services/sessions-watcher.service.js';
// Session Bridge rejects dispatch into conversations still owned by another installation.
export { assertSessionOwnerAvailable } from '@/modules/providers/services/session-owner.service.js';

export { default as providerRoutes } from './provider.routes.js';
export { createSessionHistoryCache } from './services/session-history-cache.service.js';

// Server composition wires asynchronous titles without coupling websocket internals to providers.
export { sessionTitlesService } from './services/session-titles.service.js';
