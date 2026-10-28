import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { z } from 'zod';
import { AppError } from '@/shared/index.js';
import { recordTaskmasterMetric } from './taskmaster-metrics.service.js';
import { labelInfoTask, organizeInfoUnits, assertTopicGraph } from './taskmaster-units.service.js';
import type { TopicUnit } from './taskmaster-units.service.js';
import type { InfohubRecord } from './taskmaster-infohub.model.js';

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
type Audit = { id: string; userId: number; sessionId: string; at: string; changes: { id: Task['id']; before: Task | null; after: Task }[]; undone?: boolean; beforeTopics?: TopicUnit[]; afterTopics?: TopicUnit[] };
type State = { watermarks?: Record<string, { id: string; hash: string }>; cursors: Record<string, string[]>; suggestions: Record<string, Proposal[]>; audits: Audit[]; topics?: TopicUnit[] };
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
    async reconcileInfohub(root:string,userId:number,records:InfohubRecord[],sourceTopics:TopicUnit[]) {
      return exclusive(root,async()=>{
        const data=await load(root),now=new Date().toISOString();
        const audit:Audit={id:randomUUID(),userId,sessionId:'global',at:now,changes:[]};
        const writes:{unitId:string;status:string;expectedUpdatedAt:number;taskId:string|number}[]=[],merges:{unitId:string;taskId:string|number;title:string}[]=[];
        const syncState=(data.state as State&{infohubRecords?:Record<string,{taskId:string|number;fingerprint:string}>}).infohubRecords??={};
        let backup:string|null=null;
        for(const record of records){
          let task=data.tasks.find(t=>t.source==='infohub'&&String(t.sourceId)===record.id);
          if(!task&&syncState[record.id]?.fingerprint===record.fingerprint)continue; // An undone import stays undone until its source changes.
          if(!task)task=data.tasks.find(t=>t.source!=='infohub'&&t.mergedInto===undefined&&!t.executionSessionId&&keyOf(t.title)===keyOf(String(record.fields.title))&&(!t.due||!record.fields.due||String(t.due).slice(0,10)===String(record.fields.due).slice(0,10)));
          const before=task?structuredClone(task):null;
          if(!task){task={id:Math.max(0,...data.tasks.map(t=>Number(t.id)||0))+1,title:String(record.fields.title),status:record.status,createdAt:now};data.tasks.push(task);}
          else if(task.source!=='infohub')merges.push({unitId:record.id,taskId:task.id,title:task.title});
          const meta=(task.infohub||{}) as {fingerprint?:string;lastSyncedStatus?:string;updatedAt?:number;fieldsFingerprint?:string;ignoredFieldsFingerprint?:string};
          const changedLocally=meta.lastSyncedStatus!==undefined?task.status!==meta.lastSyncedStatus:!!before&&before.status!==record.status;
          const localTime=Date.parse(String(task.infohubLocalChangedAt||task.updatedAt||task.createdAt||''))||0;
          const localWins=changedLocally&&localTime>=record.updatedAt&&(meta.fingerprint===record.fingerprint||localTime>=record.updatedAt+1000);
          const desiredStatus=localWins?task.status:record.status;
          if(localWins&&(['done','cancelled'].includes(desiredStatus)||['done','cancelled'].includes(record.status))&&desiredStatus!==record.status)writes.push({unitId:record.id,status:desiredStatus,expectedUpdatedAt:record.updatedAt,taskId:task.id});
          const evidence=[...(Array.isArray(task.originEvidence)?task.originEvidence:[]),...(before&&before.source!=='infohub'?[{source:before.source,taskId:before.id,evidence:before.description}]:[]),...(record.fields.infohubEvidence as unknown[])];
          Object.assign(task,meta.ignoredFieldsFingerprint===record.fieldsFingerprint?{}:record.fields,{status:desiredStatus,originEvidence:[...new Map(evidence.map(e=>[JSON.stringify(e),e])).values()],infohub:{fingerprint:record.fingerprint,fieldsFingerprint:record.fieldsFingerprint,...(meta.ignoredFieldsFingerprint===record.fieldsFingerprint?{ignoredFieldsFingerprint:meta.ignoredFieldsFingerprint}:{}),updatedAt:record.updatedAt,lastSyncedStatus:localWins?meta.lastSyncedStatus:record.status}});
          if(!before||JSON.stringify(before)!==JSON.stringify(task)){task.updatedAt=now;audit.changes.push({id:task.id,before,after:structuredClone(task)});}
          syncState[record.id]={taskId:task.id,fingerprint:record.fingerprint};
        }
        const topics=[...(data.state.topics||[]), ...sourceTopics];
        const dedup=[...new Map(topics.map(t=>[t.id,t])).values()];assertTopicGraph(dedup);
        if(JSON.stringify(data.state.topics||[])!==JSON.stringify(dedup)){audit.beforeTopics=structuredClone(data.state.topics||[]);audit.afterTopics=dedup;data.state.topics=dedup;}
        if(audit.changes.length||audit.afterTopics){
          backup=path.join(root,'.taskmaster','backups','infohub-'+audit.id+'.json');await fs.mkdir(path.dirname(backup),{recursive:true});try{await fs.copyFile(data.file,backup);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
          data.state.audits.push(audit);await atomic(data.file,data.document);changed(root,'tasks');
        }
        return {writes,merges,backup,auditId:audit.changes.length||audit.afterTopics?audit.id:null,imported:audit.changes.length,unmatchedLegacy:data.tasks.filter(t=>t.source&&t.source!=='infohub'&&!t.mergedInto).map(t=>({id:t.id,title:t.title,source:t.source}))};
      });
    },
    async organize(root: string, userId: number) {
      return exclusive(root, async () => {
        const data = await load(root), before = structuredClone(data.tasks);
        const backup = path.join(root, '.taskmaster', 'backups', 'info-units-' + randomUUID() + '.json');
        await fs.mkdir(path.dirname(backup), {recursive:true}); await fs.copyFile(data.file, backup);
        const result = organizeInfoUnits(data.tasks, root, data.state.topics);
        const audit: Audit = {id:randomUUID(),userId,sessionId:'global',at:new Date().toISOString(),beforeTopics:structuredClone(data.state.topics || []),afterTopics:result.topics,
          changes:result.tasks.filter((task,i)=>JSON.stringify(task)!==JSON.stringify(before[i])).map(task=>({id:task.id,before:before.find(t=>t.id===task.id)!,after:structuredClone(task as Task)}))};
        data.tasks.splice(0,data.tasks.length,...result.tasks as Task[]); data.state.topics=result.topics;
        data.state.audits.push(audit); await atomic(data.file,data.document); changed(root,'tasks');
        return {auditId:audit.id,backup,merges:result.merges,taskCount:data.tasks.length,topics:result.topics};
      });
    },
    async linkUnit(root: string, userId: number, input: {id:string;title?:string;parentIds:string[];tags?:string[]}) {
      return exclusive(root, async () => {
        const data=await load(root), beforeTopics=structuredClone(data.state.topics || []), topics=structuredClone(beforeTopics);
        if(input.id.startsWith('infohub-unit:'))throw new AppError('请在信息看板修改来源主题',{statusCode:400});
        const audit:Audit={id:randomUUID(),userId,sessionId:'global',at:new Date().toISOString(),changes:[]};
        if (input.id.startsWith('task:')) {
          const task=data.tasks.find(t=>String(t.id)===input.id.slice(5)); if(!task)throw new AppError('任务不存在',{statusCode:404});
          if(task.source==='infohub')throw new AppError('请在信息看板修改来源标签和主题',{statusCode:400});
          if(input.parentIds.some(id=>!topics.some(t=>t.id===id)))throw new AppError('父主题不存在',{statusCode:400});
          const old=structuredClone(task); Object.assign(task,{parentIds:[...new Set(input.parentIds)],...(input.tags?{tags:input.tags}:{})});
          audit.changes.push({id:task.id,before:old,after:structuredClone(task)});
        } else {
          const item=topics.find(t=>t.id===input.id); if(item)Object.assign(item,{title:input.title || item.title,parentIds:input.parentIds});
          else topics.push({id:input.id,title:input.title || input.id,parentIds:input.parentIds});
          try{assertTopicGraph(topics);}catch(e){throw new AppError(String(e),{statusCode:400});}
          audit.beforeTopics=beforeTopics; audit.afterTopics=topics; data.state.topics=topics;
        }
        data.state.audits.push(audit);await atomic(data.file,data.document);changed(root,'tasks');return {auditId:audit.id};
      });
    },
    async removeCompletedTest(root: string, userId: number, taskId: string, expectedTitle: string) {
      return exclusive(root, async () => {
        const data = await load(root), index = data.tasks.findIndex(t => String(t.id) === taskId), task = data.tasks[index];
        if (!task || task.title !== expectedTitle || !task.title.startsWith('[测试]') || task.source !== '本地验收' || task.status !== 'done') throw new AppError('仅允许清理已完成且标题匹配的本地验收任务。', { statusCode: 409 });
        data.state.audits.push({ id: randomUUID(), userId, sessionId: 'test-cleanup', at: new Date().toISOString(), changes: [{ id: task.id, before: structuredClone(task), after: { ...task, removed: true } }] });
        data.tasks.splice(index, 1); await atomic(data.file, data.document); changed(root, 'tasks'); return { removed: task.id };
      });
    },
    async importInbox(root: string, userId: number, batchId: string, items: {
      id: number | string; title: string; detail: string; source: string; due: string; urgency: string;
      options: { key: string; label: string; plan: string }[]; recommended: string;
    }[]) {
      return exclusive(root, async () => {
        const data = await load(root);
        const batches = (data.state as State & { inboxBatches?: Record<string, { hash: string; tasks: { inputId: string | number; taskId: string | number }[]; auditId: string | null }> }).inboxBatches ??= {};
        const identity = `${userId}:${batchId}`, hash = createHash('sha256').update(JSON.stringify(items)).digest('hex');
        if (batches[identity]) {
          if (batches[identity].hash !== hash) throw new AppError('批次编号已用于其他内容。', { statusCode: 409 });
          return batches[identity];
        }
        const audit: Audit = { id: randomUUID(), userId, sessionId: 'global', at: new Date().toISOString(), changes: [] };
        const mappings: { inputId: string | number; taskId: string | number }[] = [];
        for (const item of items) {
          let task = data.tasks.find(t => !['done', 'cancelled'].includes(t.status) && similar(t.title, item.title));
          const completed = !task && data.tasks.find(t => t.status === 'done' && similar(t.title, item.title));
          if (completed) {
            const before=structuredClone(completed);
            completed.originEvidence=[...new Map([...(Array.isArray(completed.originEvidence)?completed.originEvidence:[]),{source:item.source,batchId,inputId:item.id,detail:item.detail}].map(e=>[JSON.stringify(e),e])).values()];
            audit.changes.push({id:completed.id,before,after:structuredClone(completed)});mappings.push({inputId:item.id,taskId:completed.id});continue;
          }
          const before = task ? structuredClone(task) : null;
          if (!task) {
            task = { id: Math.max(0, ...data.tasks.map(t => Number(t.id) || 0)) + 1, title: item.title, status: 'pending', dependencies: [], subtasks: [], createdAt: audit.at };
            data.tasks.push(task);
          }
          Object.assign(task, { title: item.title, description: item.detail, details: item.detail,
            priority: ({ '高': 'high', '中': 'medium', '低': 'low' } as Record<string, string>)[item.urgency] ?? 'medium',
            due: item.due, source: item.source, options: item.options, recommended: item.recommended,
            batchId, batchIds: [...new Set([...(task.batchIds as string[] ?? []), batchId])], updatedAt: audit.at });
          task.originEvidence = [...new Map([...(Array.isArray(task.originEvidence)?task.originEvidence:[]), {source:item.source,batchId,inputId:item.id,detail:item.detail}].map(e=>[JSON.stringify(e),e])).values()];
          Object.assign(task,labelInfoTask(task,root));
          audit.changes.push({ id: task.id, before, after: structuredClone(task) });
          mappings.push({ inputId: item.id, taskId: task.id });
        }
        for (const change of audit.changes) change.after = structuredClone(data.tasks.find(t => t.id === change.id)!);
        if (audit.changes.length) data.state.audits.push(audit);
        const receipt = { hash, tasks: mappings, auditId: audit.changes.length ? audit.id : null };
        batches[identity] = receipt;
        await atomic(data.file, data.document); changed(root, 'tasks'); return receipt;
      });
    },
    async globalSnapshot(root: string, userId: number) {
      const data = await load(root);
      return { topics:data.state.topics || [], audits: data.state.audits.filter(a => a.userId === userId && a.sessionId === 'global').slice(-30).map(a => ({ id: a.id, at: a.at, undone: a.undone, changes: a.changes.map(c => ({ id: c.id, title: c.after.title, status: c.after.status })) })) };
    },
    async changeInboxTask(root: string, userId: number, taskId: string, mutate: (task: Task) => Promise<Record<string, unknown>>) {
      return exclusive(root, async () => {
        const data = await load(root), task = data.tasks.find(t => String(t.id) === taskId);
        if (!task) throw new AppError('任务不存在。', { statusCode: 404 });
        const before = structuredClone(task), changes = await mutate(structuredClone(task));
        Object.assign(task, changes, { updatedAt: new Date().toISOString() });
        if(task.source==='infohub'&&changes.status!==undefined&&changes.status!==before.status)task.infohubLocalChangedAt=task.updatedAt;
        const execution = changes.executionSessionId !== undefined;
        const audit: Audit = { id: randomUUID(), userId, sessionId: execution ? 'execution' : 'global', at: new Date().toISOString(), changes: [{ id: task.id, before, after: structuredClone(task) }] };
        data.state.audits.push(audit); await atomic(data.file, data.document); changed(root, 'tasks');
        return { task, auditId: execution ? null : audit.id };
      });
    },
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
      return { currentTag: data.tag, tasks: data.tasks.map(t => ({ ...labelInfoTask(t,root), sources: (t.sources as { userId: number }[] | undefined)?.filter(source => source.userId === userId), autoUpdate: (t.autoUpdate as { userId: number } | undefined)?.userId === userId ? t.autoUpdate : undefined } as Task)) };
    },
    async snapshot(root: string, userId: number, sessionId: string) {
      const data = await load(root), key = `${userId}:${sessionId}`;
      return { tasks: data.tasks.filter(task => (task.sources as { userId: number; sessionId: string }[] | undefined)?.some(s => s.userId === userId && s.sessionId === sessionId)).map(t => ({ ...t, sources: (t.sources as { userId: number }[]).filter(s => s.userId === userId), autoUpdate: (t.autoUpdate as { userId: number } | undefined)?.userId === userId ? t.autoUpdate : undefined })),
        suggestions: data.state.suggestions[key] ?? [], audits: data.state.audits.filter(a => a.userId === userId && a.sessionId === sessionId).slice(-30).map(a => ({ id: a.id, at: a.at, undone: a.undone, changes: a.changes.map(c => ({ id: c.id, beforeStatus: c.before?.status, afterStatus: c.after.status })) })) };
    },
    async extract(root: string, userId: number, sessionId: string, messages: Message[], suggestOnly: boolean, confirm = false, automatic = false) {
      return exclusive(root, async () => {
        const data = await load(root), key = `${userId}:${sessionId}`;
        const hashes = messages.map(fingerprint), cursor = data.state.cursors[key] ?? [];
        let common = 0; while (common < cursor.length && common < hashes.length && cursor[common] === hashes[common]) common++;
        const watermark = data.state.watermarks?.[key];
        const position = watermark ? messages.findIndex(m => m.id === watermark.id) : -1;
        const start = position >= 0 ? position + (hashes[position] === watermark!.hash ? 1 : 0) : Math.max(0, messages.length - 40);
        const candidates = automatic ? messages.slice(start) : messages.slice(common);
        const checkpoint = async () => {
          const last = messages.at(-1);
          if (last) (data.state.watermarks ??= {})[key] = { id: last.id, hash: hashes.at(-1)! };
          data.state.cursors[key] = hashes;
          await atomic(data.file, data.document);
        };
        const skip = async (reason: string) => {
          await recordTaskmasterMetric({ sessionId, userId, model: null, inputChars: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, skipped: true, reason });
          if (automatic) await checkpoint();
          return { status: reason, created: 0, updated: 0, auditId: null };
        };
        if (!confirm && candidates.length === 0) return skip('unchanged');
        if (!confirm && automatic && !candidates.some(m => m.role === 'user' || (m.role === 'tool' && /完成|通过|失败|成功|错误|\b(pass(?:ed)?|fail(?:ed|ure)?|success|error|completed?|exit(?: code)?["\s:]*[0-9])\b/i.test(m.content)))) return skip('no-actionable-messages');
        // Keep task matching context small and reserve most of the budget for the newest evidence.
        const existingTasks: { id: Task['id']; title: string; status: string; acceptance: string }[] = [];
        for (const t of data.tasks.filter(t => !['done', 'cancelled'].includes(t.status)).reverse()) {
          const compact = { id: t.id, title: t.title.slice(0, 300), status: t.status, acceptance: String(t.testStrategy ?? '').slice(0, 500) };
          if (JSON.stringify([...existingTasks, compact]).length > 7000) break;
          existingTasks.push(compact);
        }
        const fresh: Message[] = [];
        const input = { sessionId, messages: fresh, existingTasks };
        for (let i = candidates.length - 1; i >= 0; i--) {
          const m = { ...candidates[i], content: candidates[i].content.slice(0, 5000) };
          fresh.unshift(m);
          if (JSON.stringify(input).length > 22000) {
            if (fresh.length === 1) {
              while (m.content.length && JSON.stringify(input).length > 22000) m.content = m.content.slice(Math.ceil(m.content.length / 2));
            } else fresh.shift();
            break;
          }
        }
        const proposals = confirm ? data.state.suggestions[key] ?? [] : resultSchema.parse(await generate(input)).tasks;
        const evidenceMessages = confirm ? messages : fresh;
        const validIds = new Set(evidenceMessages.map(m => m.id));
        const audit: Audit = { id: randomUUID(), userId, sessionId, at: new Date().toISOString(), changes: [] };
        const suggestions: Proposal[] = [];
        const references = new Map<string, Task['id']>(); const dependencies: { task: Task; refs: (string | number)[] }[] = [];
        let created = 0, updated = 0;
        for (const item of proposals) {
          const evidenceMessage = evidenceMessages.find(m => m.id === item.messageId);
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
          if(task.source==='infohub'&&before?.status!==task.status)task.infohubLocalChangedAt=audit.at;
          references.set(item.title, task.id); if (item.taskId !== undefined) references.set(String(item.taskId), task.id);
          dependencies.push({ task, refs: item.dependencies });
          const sources = (task.sources ?? []) as { userId: number; sessionId: string; messageId: string; evidence: string }[];
          if (!sources.some(s => s.userId === userId && s.sessionId === sessionId && s.messageId === item.messageId)) sources.push({ userId, sessionId, messageId: item.messageId, evidence: item.evidence });
          task.sources = sources; task.autoUpdate = { userId, evidence: item.evidence, at: audit.at };
          Object.assign(task,labelInfoTask(task,root));
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
        if (!confirm) {
          data.state.cursors[key] = hashes;
          const last = messages.at(-1);
          if (last) (data.state.watermarks ??= {})[key] = { id: last.id, hash: hashes.at(-1)! };
        }
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
        for (const [id, after] of expected) {const current=data.tasks.find(t => String(t.id) === id);const comparable=(t:Task|undefined)=>{if(!t||t.source!=='infohub')return JSON.stringify(t);const {infohub,updatedAt,infohubLocalChangedAt,...fields}=t;return JSON.stringify(fields);};if(comparable(current)!==comparable(after))throw new AppError('任务后来有新改动，请先撤销最近的更新。',{statusCode:409});}
        if(audit.afterTopics && JSON.stringify(data.state.topics || [])!==JSON.stringify(audit.afterTopics))throw new AppError('主题后来有新改动，请先撤销最近的更新。',{statusCode:409});
        for (const change of [...audit.changes].reverse()) { const index = data.tasks.findIndex(t => String(t.id) === String(change.id)); const currentInfohub=data.tasks[index]?.infohub; if (change.before) {data.tasks[index] = structuredClone(change.before);if(data.tasks[index].source==='infohub'){data.tasks[index].updatedAt=new Date().toISOString();data.tasks[index].infohubLocalChangedAt=data.tasks[index].updatedAt;const meta:Record<string,unknown>={...((currentInfohub||change.after.infohub||data.tasks[index].infohub||{}) as Record<string,unknown>),lastSyncedStatus:change.after.status};if(typeof meta.fieldsFingerprint==='string')Object.assign(meta,{ignoredFieldsFingerprint:meta.fieldsFingerprint});data.tasks[index].infohub=meta;}}  else data.tasks.splice(index, 1); }
        if(audit.beforeTopics)data.state.topics=structuredClone(audit.beforeTopics);
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
        if(task.source==='infohub'&&parsed.status)task.infohubLocalChangedAt=task.updatedAt;
        await atomic(data.file, data.document); changed(root, 'tasks'); return { task };
      });
    },
    async add(root: string, input: Record<string, unknown>, userId = 0) {
      if (input.prompt) return this.extract(root, 0, 'manual', [{ id: 'manual', role: 'user', content: String(input.prompt) }], false);
      return exclusive(root, async () => {
        const parsed = z.object({ title: z.string().min(1).max(300), description: z.string().max(5000).default(''), priority: z.enum(['high', 'medium', 'low']).default('medium'), tags: z.array(z.string().max(120)).max(30).default([]) }).parse(input);
        const data = await load(root), task = { ...parsed, id: Math.max(0, ...data.tasks.map(t => Number(t.id) || 0)) + 1, status: 'pending', createdAt: new Date().toISOString() };
        Object.assign(task,labelInfoTask(task,root));
        const audit:Audit={id:randomUUID(),userId,sessionId:'global',at:new Date().toISOString(),changes:[{id:task.id,before:null,after:structuredClone(task)}]};
        data.tasks.push(task);data.state.audits.push(audit); await atomic(data.file, data.document); changed(root, 'tasks'); return { task, auditId:audit.id };
      });
    },
  };
}
