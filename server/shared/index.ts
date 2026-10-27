export { appendFilesInputTag, appendImagesInputTag, buildClaudeUserContent, buildCodexInputItems, normalizeImageDescriptors } from './image-attachments.js';
export { AppError, createCompleteMessage, createNormalizedMessage } from './utils.js';
// Provider adapters use the shared verified process-tree terminator for cancellation and protocol failures.
export { killProcessTree } from './process-tree.js';
// Provider adapters locate their packaged launcher alongside source or compiled server modules.
export { findApplicationRoot, getModuleDirectory } from './utils.js';
export { asyncHandler, createApiSuccessResponse } from './utils.js';
export type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter, ProviderPermissionDecision } from './types.js';

export { getClaudeConfigDir, getClaudeConfigFile } from './utils.js';
export { createClaudeLaunchEnvironment } from './utils.js';
export { requireAuthenticatedUserId } from './utils.js';
export { getCloudCliHomeDir } from './utils.js';
export { parseMonitorCalendarSchedule, nextMonitorCalendarRun } from './utils.js';
export type { MonitorCalendarSchedule } from './types.js';
// Dot and Database exchange revisioned assistant state through the shared contract.
export type { DotMemory, DotThread, DotTask } from './types.js';
// Auth retains the existing platform deployment mode alongside private local identity.
export { IS_PLATFORM } from './utils.js';

// Auth binds isolated execution contexts; Database and filesystem helpers read them.
export { userContextStorage } from './utils.js';

// Providers use these contracts and helpers to implement local WorkBuddy sessions.
export type { IProviderAuth, IProviderModels, IProviderRuntime, IProviderSessions, IProviderMcp, IProviderSkills } from './interfaces.js';
export type { ProviderAuthStatus, ProviderModelsDefinition, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from './types.js';
export { buildDefaultProviderCurrentActiveModel, readObjectRecord, sliceTailPage } from './utils.js';
