export { initializeDatabase } from '@/modules/database/init-db.js';
export { closeConnection, getConnection, getDatabasePath } from '@/modules/database/connection.js';
export { apiKeysDb } from '@/modules/database/repositories/api-keys.js';
export { appConfigDb } from '@/modules/database/repositories/app-config.js';
export { credentialsDb } from '@/modules/database/repositories/credentials.js';
export { githubTokensDb } from '@/modules/database/repositories/github-tokens.js';
export { notificationChannelEndpointsDb } from '@/modules/database/repositories/notification-channel-endpoints.js';
export { notificationPreferencesDb } from '@/modules/database/repositories/notification-preferences.js';
// providerModelsDb: used by Providers to persist user-managed custom model rows.
export { providerModelsDb } from '@/modules/database/repositories/provider-models.js';
// projectsDb: used by Projects, Worktrees, Git, WebSocket, and notification modules to persist and resolve project records.
export { projectsDb } from '@/modules/database/repositories/projects.db.js';
export { pushSubscriptionsDb } from '@/modules/database/repositories/push-subscriptions.js';
export { scanStateDb } from '@/modules/database/repositories/scan-state.db.js';
// sessionDraftsDb: used by User for drafts and Scheduled Messages for server-owned queued turns.
export { sessionDraftsDb } from '@/modules/database/repositories/session-drafts.db.js';
export type {
  QueuedSessionMessageRecord,
  SessionDraftRecord,
} from '@/modules/database/repositories/session-drafts.db.js';
export { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
export { userDb } from '@/modules/database/repositories/users.js';
// userPreferencesDb: used by the User module to persist the settings that used to live in browser localStorage.
export { userPreferencesDb } from '@/modules/database/repositories/user-preferences.db.js';
export { vapidKeysDb } from '@/modules/database/repositories/vapid-keys.js';
export { scheduledMessagesDb } from './repositories/scheduled-messages.db.js';
export type { ScheduledMessageRow, ScheduledMessageStatus } from './repositories/scheduled-messages.db.js';

// Monitors uses this repository for durable schedules and execution receipts.
export { monitorsDb, initializeMonitorTables } from '@/modules/database/repositories/monitors.db.js';
// Workbench lifecycle modules own side-chat relationships and durable FIFO submissions.
export { sideChatsDb } from '@/modules/database/repositories/side-chats.db.js';
export { messageQueueDb } from '@/modules/database/repositories/message-queue.db.js';
// Session Workspace and websocket completion events share user-scoped navigation/queue controls.
export { sessionWorkspaceDb } from '@/modules/database/repositories/session-workspace.db.js';
// Workspace Sections persists revisioned, user-scoped sidebar organization.
export { workspaceSectionsDb } from '@/modules/database/repositories/workspace-sections.db.js';
// Session Bridge uses bounded searches over the shared local session index.
export { sessionBridgeDb } from '@/modules/database/repositories/session-bridge.db.js';
// Auth uses revocable login sessions and a distinct remote credential.
export { authSessionsDb } from '@/modules/database/repositories/auth-sessions.db.js';

// Projects, Providers and WebSocket share indexed resource ownership.
export { getOwnerUserId, getSessionOwnerId } from './ownership.js';

// Project Organization stores account-local navigation separately from discovered disk paths.
export { projectOrganizationDb } from './repositories/project-organization.db.js';
