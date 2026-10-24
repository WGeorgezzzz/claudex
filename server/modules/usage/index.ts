// Server composition mounts authenticated usage routes and manages the background scanner.
export { usageRoutes } from './usage.routes.js';
export { initializeUsage, closeUsage } from './usage.service.js';
// Database migrations create the durable usage tables before scanner startup.
export { initializeUsageTables } from './usage.db.js';
