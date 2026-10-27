import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { z } from 'zod';
import { AppError } from '@/shared/index.js';

const status = z.enum(['pending', 'in-progress', 'done', 'blocked', 'cancelled', 'review', 'deferred']);
const proposal = z.object({
  taskId: z.union([z.string(), z.number()]).optional(), title: z.string().min(1).max(300),
  description: z.string().max(5000).default(''), acceptance: z.string().max(3000).default(''),
  priority: z.enum(['high', 'medium', 'low']).default('medium'), status: status.default('pending'),
  dependencies: z.array(z.union([z.number(), z.string()])).max(30).default([]),
  subtasks: z.array(z.object({ title: z.string().min(1).max(300), description: z.string().max(3000).default('') })).max(20).default([]),
  confidence: z.number().min(0).max(1), evidence: z.string().min(1).max(1500), messageId: z.string().min(1).max(300),
});
const resultSchema = z.object({ tasks: z.array(proposal).max(30) });
type Proposal = z.infer<typeof proposal>;
type Task = Record<string, unknown> & { id: number | string; title: string; status: string; subtasks?: Task[] };
type Message = { id: string; role: string; content: string };
type Audit = { id: string; userId: number; sessionId: string; at: string; changes: { id: Task['id']; before: Task | null; after: Task }[]; undone?: boolean };
type State = { cursors: Record<string, string[]>; suggestions: Record<string, Proposal[]>; audits: Audit[] };
type Document = Record<string, unknown>;
const locks = new Map<string, Promise<unknown>>();
function keyOf(text: string) { return text.toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, ''); }
function similar(a: string, b: string) {
  a = keyOf(a); b = keyOf(b);
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5) return false;
  const grams = (s: string) => new Set(Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)));
  const x = grams(a), y = grams(b);
  return 2 * [...x].filter(g => y.has(g)).length / (x.size + y.size) >= 0.78;
}
function fingerprint(message: Message) { return createHash('sha256').update(JSON.stringify(message)).digest('hex'); }
async function exclusive<T>(root: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(root) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(run); locks.set(root, current);
  try { return await current; } finally { if (locks.get(root) === current) locks.delete(root); }
}
async function atomic(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8'); await fs.rename(temporary, file); }
  finally { await fs.unlink(temporary).catch(() => {}); }
}
async function load(root: string) {
  const file = path.join(root, '.taskmaster', 'tasks', 'tasks.json');
  let raw: unknown;
  try { raw = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; raw = { master: { tasks: [] } }; }
  const document: Document = Array.isArray(raw) ? { master: { tasks: raw } } : raw as Document;
  if (!document || typeof document !== 'object') throw new AppError('任务文件格式不正确，原文件已保留。', { statusCode: 409 });
  if (Array.isArray(document.tasks)) { document.master = { tasks: document.tasks }; delete document.tasks; }
  let tag = 'master';
  try { const active = JSON.parse(await fs.readFile(path.join(root, '.taskmaster', 'state.json'), 'utf8')).currentTag; if (typeof active === 'string') tag = active; } catch { /* Default tag for a new project. */ }
  const group = document[tag] as { tasks?: Task[] } | undefined;
  if (!Array.isArray(group?.tasks)) {
    const available = Object.keys(document).find(k => k !== '_nexagent' && Array.isArray((document[k] as { tasks?: Task[] })?.tasks));
    if (available) tag = available; else document[tag] = { tasks: [] };
  }
  const tasks = (document[tag] as { tasks: Task[] }).tasks;
  const active = document[tag] as { tasks: Task[]; metadata?: Record<string, unknown> };
  active.metadata ??= {};
  const state = (active.metadata.nexagent as State | undefined) ?? { cursors: {}, suggestions: {}, audits: [] };
  active.metadata.nexagent = state;
  return { document, tasks, state, file, tag };
}

/** TaskMaster module routes and completion hooks share atomic native writes; no subprocesses are created. */
export function createTaskmasterWorkspaceService(generate: (input: unknown) => Promise<unknown>, changed: (root: string, kind: 'project' | 'tasks') => void = () => {}) {
  return {
    async initialize(root: string) {
      return exclusive(root, async () => {
        for (const directory of ['tasks', 'docs', 'reports']) await fs.mkdir(path.join(root, '.taskmaster', directory), { recursive: true });
        const config = path.join(root, '.taskmaster', 'config.json');
        try { await fs.writeFile(config, JSON.stringify({ models: {
          main: { provider: 'claude-code', modelId: 'sonnet', maxTokens: 64000, temperature: 0.2 },
          research: { provider: 'codex-cli', modelId: 'gpt-5.2-codex', maxTokens: 64000, temperature: 0.1 },
          fallback: { provider: 'codex-cli', modelId: 'gpt-5.2-codex', maxTokens: 64000, temperature: 0.2 },
        }, global: { projectName: path.basename(root), defaultTag: 'master' } }, null, 2), { encoding: 'utf8', flag: 'wx' }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const data = await load(root); await atomic(data.file, data.document); changed(root, 'project');
        return { hasTaskmaster: true, status: 'configured', taskCount: data.tasks.length };
      });
    },
    async expand(root: string, taskId: string) {
      return exclusive(root, async () => {
        const data = await load(root), task = data.tasks.find(t => String(t.id) === taskId);
        if (!task) throw new AppError('任务不存在。', { statusCode: 404 });
        const result = resultSchema.parse(await generate({ purpose: 'Decompose the existing task into grounded actionable subtasks. Return one task with subtasks.', messages: [{ id: 'expand', role: 'user', content: JSON.stringify(task) }], existingTasks: [{ id: task.id, title: task.title, status: task.status }] }));
        task.subtasks ??= [];
        for (const sub of result.tasks[0]?.subtasks ?? []) if (!task.subtasks.some(t => similar(t.title, sub.title))) task.subtasks.push({ id: String(task.id) + '.' + (task.subtasks.length + 1), title: sub.title, description: sub.description, status: 'pending' });
        task.updatedAt = new Date().toISOString(); await atomic(data.file, data.document); changed(root, 'tasks'); return { task };
      });
    },
    async list(root: string, userId: number) {
      const data = await load(root);
      return { currentTag: data.tag, tasks: data.tasks.map(t => ({ ...t, sources: (t.sources as { userId: number }[] | undefined)?.filter(source => source.userId === userId), autoUpdate: (t.autoUpdate as { userId: number } | undefined)?.userId === userId ? t.autoUpdate : undefined })) };
    },
    async snapshot(root: string, userId: number, sessionId: string) {
      const data = await load(root), key = `${userId}:${sessionId}`;
      return { tasks: data.tasks.filter(task => (task.sources as { userId: number; sessionId: string }[] | undefined)?.some(s => s.userId === userId && s.sessionId === sessionId)).map(t => ({ ...t, sources: (t.sources as { userId: number }[]).filter(s => s.userId === userId), autoUpdate: (t.autoUpdate as { userId: number } | undefined)?.userId === userId ? t.autoUpdate : undefined })),
        suggestions: data.state.suggestions[key] ?? [], audits: data.state.audits.filter(a => a.userId === userId && a.sessionId === sessionId).slice(-30).map(a => ({ id: a.id, at: a.at, undone: a.undone, changes: a.changes.map(c => ({ id: c.id, beforeStatus: c.before?.status, afterStatus: c.after.status })) })) };
    },
    async extract(root: string, userId: number, sessionId: string, messages: Message[], suggestOnly: boolean, confirm = false) {
      return exclusive(root, async () => {
        const data = await load(root), key = `${userId}:${sessionId}`;
        const hashes = messages.map(fingerprint), cursor = data.state.cursors[key] ?? [];
        let common = 0; while (common < cursor.length && common < hashes.length && cursor[common] === hashes[common]) common++;
        const fresh = messages.slice(common, common + 60);
        if (!confirm && fresh.length === 0) return { status: 'unchanged', created: 0, updated: 0 };
        const proposals = confirm ? data.state.suggestions[key] ?? [] : resultSchema.parse(await generate({
          messages: fresh.map(m => ({ ...m, content: m.content.slice(0, 5000) })),
          existingTasks: data.tasks.map(t => ({ id: t.id, title: t.title, description: t.description, status: t.status, subtasks: t.subtasks })),
        })).tasks;
        const validIds = new Set(messages.map(m => m.id));
        const audit: Audit = { id: randomUUID(), userId, sessionId, at: new Date().toISOString(), changes: [] };
        const suggestions: Proposal[] = [];
        const references = new Map<string, Task['id']>(); const dependencies: { task: Task; refs: (string | number)[] }[] = [];
        let created = 0, updated = 0;
        for (const item of proposals) {
          const evidenceMessage = messages.find(m => m.id === item.messageId);
          if (!validIds.has(item.messageId) || !evidenceMessage?.content.includes(item.evidence)) continue;
          if (!confirm && (suggestOnly || item.confidence < 0.85)) { suggestions.push(item); continue; }
          // Model-selected ids provide semantic matching; lexical matching also catches repeated proposals.
          let task = data.tasks.find(t => String(t.id) === String(item.taskId)) ?? data.tasks.find(t => similar(t.title, item.title));
          const before = task ? structuredClone(task) : null;
          if (!task) {
            task = { id: Math.max(0, ...data.tasks.map(t => Number(t.id) || 0)) + 1, title: item.title, status: 'pending',
              description: item.description, testStrategy: item.acceptance, priority: item.priority, dependencies: item.dependencies.filter(id => data.tasks.some(t => String(t.id) === String(id))),
              createdAt: audit.at, sources: [], subtasks: [] };
            data.tasks.push(task); created++;
          } else updated++;
          // Completion/blocked/cancelled must be evidenced explicitly, never inferred from an intention.
          task.status = item.status; task.updatedAt = audit.at;
          references.set(item.title, task.id); if (item.taskId !== undefined) references.set(String(item.taskId), task.id);
          dependencies.push({ task, refs: item.dependencies });
          const sources = (task.sources ?? []) as { userId: number; sessionId: string; messageId: string; evidence: string }[];
          if (!sources.some(s => s.userId === userId && s.sessionId === sessionId && s.messageId === item.messageId)) sources.push({ userId, sessionId, messageId: item.messageId, evidence: item.evidence });
          task.sources = sources; task.autoUpdate = { userId, evidence: item.evidence, at: audit.at };
          task.subtasks ??= [];
          for (const sub of item.subtasks) if (!task.subtasks.some(t => similar(t.title, sub.title))) task.subtasks.push({ id: `${task.id}.${task.subtasks.length + 1}`, title: sub.title, description: sub.description, status: 'pending' });
          audit.changes.push({ id: task.id, before, after: structuredClone(task) });
        }
        for (const pending of dependencies) {
          const ids = pending.refs.map(ref => data.tasks.find(t => String(t.id) === String(ref) || t.title === String(ref))?.id ?? references.get(String(ref)))
            .filter((id): id is Task['id'] => id !== undefined && String(id) !== String(pending.task.id));
          if (ids.length) pending.task.dependencies = [...new Set(ids)];
        }
        // Receipts describe the final dependency-resolved state, which undo compares before restoring.
        for (const change of audit.changes) change.after = structuredClone(data.tasks.find(t => t.id === change.id)!);
        data.state.suggestions[key] = confirm ? [] : [...(data.state.suggestions[key] ?? []).filter(old => !proposals.some(p => similar(p.title, old.title))), ...suggestions];
        if (!confirm) data.state.cursors[key] = hashes.slice(0, common + fresh.length);
        if (audit.changes.length) data.state.audits.push(audit);
        await atomic(data.file, data.document);
        if (audit.changes.length) changed(root, 'tasks');
        return { status: suggestions.length ? 'suggestions' : 'ready', created, updated, suggested: suggestions.length, auditId: audit.changes.length ? audit.id : null };
      });
    },
    async undo(root: string, userId: number, sessionId: string, auditId: string) {
      return exclusive(root, async () => {
        const data = await load(root), audit = data.state.audits.find(a => a.id === auditId && a.userId === userId && a.sessionId === sessionId && !a.undone);
        if (!audit) throw new AppError('找不到可撤销的记录。', { statusCode: 404 });
        // Refuse to erase subsequent manual edits or another extraction's work.
        const expected = new Map<string, Task>(); for (const c of audit.changes) expected.set(String(c.id), c.after);
        for (const [id, after] of expected) if (JSON.stringify(data.tasks.find(t => String(t.id) === id)) !== JSON.stringify(after)) throw new AppError('任务后来有新改动，请先撤销最近的更新。', { statusCode: 409 });
        for (const change of [...audit.changes].reverse()) { const index = data.tasks.findIndex(t => String(t.id) === String(change.id)); if (change.before) data.tasks[index] = change.before; else data.tasks.splice(index, 1); }
        audit.undone = true;
        await atomic(data.file, data.document); changed(root, 'tasks'); return { status: 'undone' };
      });
    },
    async update(root: string, taskId: string, changes: Record<string, unknown>) {
      return exclusive(root, async () => {
        const data = await load(root), task = data.tasks.flatMap(t => [t, ...(t.subtasks ?? [])]).find(t => String(t.id) === taskId);
        if (!task) throw new AppError('任务不存在。', { statusCode: 404 });
        const parsed = z.object({ title: z.string().min(1).max(300).optional(), description: z.string().max(5000).optional(), status: status.optional(), priority: z.enum(['high', 'medium', 'low']).optional(), details: z.string().max(10000).optional() }).strict().parse(changes);
        Object.assign(task, parsed, { updatedAt: new Date().toISOString() });
        await atomic(data.file, data.document); changed(root, 'tasks'); return { task };
      });
    },
    async add(root: string, input: Record<string, unknown>) {
      if (input.prompt) return this.extract(root, 0, 'manual', [{ id: 'manual', role: 'user', content: String(input.prompt) }], false);
      return exclusive(root, async () => {
        const parsed = z.object({ title: z.string().min(1).max(300), description: z.string().max(5000).default(''), priority: z.enum(['high', 'medium', 'low']).default('medium') }).parse(input);
        const data = await load(root), task = { ...parsed, id: Math.max(0, ...data.tasks.map(t => Number(t.id) || 0)) + 1, status: 'pending' };
        data.tasks.push(task); await atomic(data.file, data.document); changed(root, 'tasks'); return { task };
      });
    },
  };
}
