// Server consumes the authenticated router and lifecycle; tests exercise dispatch directly.
export { monitorsRoutes } from './monitors.routes.js';
export { initializeMonitors, closeMonitors, dispatchMonitors } from './monitors.dispatcher.js';
// Providers attaches tools when constructing authenticated Claude SDK queries.
export { createMonitorQuery, createCodexMonitorTool } from './monitors.tools.js';
