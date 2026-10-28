import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { assertOwnedSession, assertContextPath, requireContextUserId } from '@/modules/access-control/index.js';
import { withUserContext, getCurrentUserContext } from '@/modules/auth/index.js';
import { projectsDb, projectOrganizationDb, userPreferencesDb } from '@/modules/database/index.js';
import { sessionsService, providerRuntimeService } from '@/modules/providers/index.js';
import { chatRunRegistry, connectedClients, clientUserIds, WS_OPEN_STATE } from '@/modules/websocket/index.js';
import { AppError } from '@/shared/index.js';
import { createTaskmasterWorkspaceService } from './taskmaster-workspace.service.js';
import { generateTaskmasterExtraction } from './taskmaster-model.service.js';
import { recordTaskmasterMetric } from './taskmaster-metrics.service.js';

const settingsSchema = z.object({ enabled: z.boolean().default(true), suggestOnly: z.boolean().default(false), disabledProjects: z.array(z.string().max(200)).max(1000).default([]) });
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const errors = new Map<string, string>();
/** Composition root and routes share TaskMaster-compatible native workspaces. */
export const taskmasterWorkspace = createTaskmasterWorkspaceService(generateTaskmasterExtraction, (root, kind) => {
  const projectId = projectsDb.getProjectPath(root)?.project_id, userId = getCurrentUserContext()?.userId;
  if (!projectId || !userId) return;
  const frame = JSON.stringify({ type: kind === 'project' ? 'taskmaster-project-updated' : 'taskmaster-tasks-updated', projectId });
  for (const client of connectedClients) if (client.readyState === WS_OPEN_STATE && clientUserIds.get(client) === userId) client.send(frame);
});
function resolveSession(sessionId: string) {
  const userId = requireContextUserId(), session = assertOwnedSession(userId, sessionId);
  const layout = projectOrganizationDb.read(userId), explicit = layout.threads[sessionId];
  const project = explicit ? (explicit.projectId ? projectsDb.getProjectPathById(explicit.projectId) : null) : session.project_path;
  if (!project) return { userId, root: null };
  const root = path.resolve(project); assertContextPath(root); assertContextPath(path.join(root, '.taskmaster'));
  for (const relative of ['config.json', 'state.json', 'tasks', 'tasks/tasks.json', 'docs', 'reports']) assertContextPath(path.join(root, '.taskmaster', relative));
  return { userId, root };
}
/** Chat completion and authenticated TaskMaster routes orchestrate extraction without dispatching another conversation. */
export const taskmasterAutoService = {
  settings(userId = requireContextUserId()) {
    return settingsSchema.parse(userPreferencesDb.getPreferences(userId)['taskmasterAuto'] ?? {});
  },
  saveSettings(input: unknown) {
    const parsed = settingsSchema.parse(input), userId = requireContextUserId();
    userPreferencesDb.savePreferences(userId, { taskmasterAuto: parsed }); return parsed;
  },
  async snapshot(sessionId: string) {
    const { userId, root } = resolveSession(sessionId);
    return { ...(root ? await taskmasterWorkspace.snapshot(root, userId, sessionId) : { tasks: [], suggestions: [], audits: [] }),
      settings: this.settings(userId), root, error: errors.get(`${userId}:${sessionId}`) ?? null, skipped: root ? null : '无项目对话不写入任务集。' };
  },
  async extract(sessionId: string, confirm = false, automatic = false) {
    const { userId, root } = resolveSession(sessionId), settings = this.settings(userId);
    const skip = async (reason: string) => {
      await recordTaskmasterMetric({ sessionId, userId, model: null, inputChars: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, skipped: true, reason });
      return { status: reason };
    };
    if (!root) return skip('projectless');
    if (!settings.enabled || settings.disabledProjects.includes(root)) return skip('disabled');
    const running = chatRunRegistry.isProcessing(sessionId) || providerRuntimeService.hasBackgroundWork(sessionId);
    if (automatic && running) return skip('running');
    if (running) throw new AppError('请等本轮回复结束再整理。', { statusCode: 409 });
    const history = await sessionsService.fetchHistory(sessionId, { limit: null, offset: 0 });
    const messages = history.messages.filter(m => !m.parentToolUseId && ((m.kind === 'text' && ['user', 'assistant'].includes(m.role ?? '')) || (m.kind === 'tool_use' && m.toolResult)))
      .map(m => ({ id: m.id, role: m.kind === 'tool_use' ? 'tool' : m.role!, content: m.kind === 'tool_use'
        ? JSON.stringify({ tool: m.toolName, outcome: m.toolResult?.isError ? 'failed' : undefined, input: JSON.stringify(m.toolInput ?? '').slice(0, 600), result: (() => { const result = JSON.stringify(m.toolResult); return result.length > 1200 ? result.slice(0, 600) + '\n…\n' + result.slice(-600) : result; })() }) : m.content ?? '' }));
    const result = await taskmasterWorkspace.extract(root, userId, sessionId, messages, settings.suggestOnly, confirm, automatic);
    if (result.created || result.updated) await taskmasterWorkspace.initialize(root);
    errors.delete(`${userId}:${sessionId}`); return result;
  },
  async undo(sessionId: string, auditId: string) {
    const { userId, root } = resolveSession(sessionId);
    if (!root) throw new AppError('此对话没有项目。', { statusCode: 400 });
    return taskmasterWorkspace.undo(root, userId, sessionId, auditId);
  },
  schedule(sessionId: string, userId: number, attempt = 0) {
    const key = `${userId}:${sessionId}`; clearTimeout(timers.get(key));
    const timer = setTimeout(() => {
      timers.delete(key);
      void Promise.resolve().then(() => withUserContext(userId, () => this.extract(sessionId, false, true))).catch(error => {
        const retry = error instanceof AppError && error.code === 'TASKMASTER_MODEL_BUSY' && attempt < 2 && !timers.has(key);
        errors.set(key, (error instanceof Error ? error.message : '自动整理暂不可用') + (retry ? ' 一分钟后自动重试。' : ''));
        if (retry) this.schedule(sessionId, userId, attempt + 1);
        console.warn('[TaskMaster] automatic extraction failed', { sessionId, error: String(error) });
      });
    }, attempt ? 60000 : 180000);
    timer.unref(); timers.set(key, timer);
  },
  async parsePrd(root: string, fileName: string, userId: number) {
    if (!fileName || path.basename(fileName) !== fileName) throw new AppError('请选择有效的需求文件。', { statusCode: 400 });
    const file = path.join(root, '.taskmaster', 'docs', fileName); assertContextPath(file);
    const content = await readFile(file, 'utf8');
    if (content.length > 100000) throw new AppError('需求文件过长，请拆分后生成。', { statusCode: 400 });
    return taskmasterWorkspace.extract(root, userId, `prd:${fileName}`, [{ id: fileName, role: 'user', content }], false);
  },
};
