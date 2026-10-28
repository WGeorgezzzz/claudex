import path from 'node:path';

export type TopicUnit = { id: string; title: string; parentIds: string[] };
export type InfoTask = Record<string, unknown> & {id: string | number; title: string; status: string};
const key = (title: string) => title.toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');

/** Source tags and project membership are authoritative; no title-based AI topic organizer. */
export function labelInfoTask(task: InfoTask, root: string): InfoTask {
  const tags=new Set<string>(Array.isArray(task.tags)?task.tags as string[]:[]);
  if(![...tags].some(t=>t.startsWith('project:')))tags.add('project:'+path.basename(root));
  if(![...tags].some(t=>t.startsWith('source:')))tags.add('source:'+(task.source==='infohub'?'infohub':Array.isArray(task.sources)&&task.sources.length?'conversation':task.source?'legacy':'manual'));
  if(![...tags].some(t=>t.startsWith('type:')))tags.add('type:todo');
  return {...task,tags:[...tags]};
}

/** Multi-parent graph validation fails before writing any task file. */
export function assertTopicGraph(topics: TopicUnit[]): void {
  const map = new Map(topics.map(t => [t.id, t]));
  if (map.size !== topics.length) throw new Error('主题 ID 重复');
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('主题链接不能形成环');
    if (visited.has(id)) return;
    const topic = map.get(id); if (!topic) throw new Error('父主题不存在');
    visiting.add(id); topic.parentIds.forEach(visit); visiting.delete(id); visited.add(id);
  };
  topics.forEach(t => visit(t.id));
}

/** Keeps merged records and every source as reversible evidence instead of deleting duplicates. */
export function organizeInfoUnits(tasks: InfoTask[], root: string, existing: TopicUnit[] = []) {
  const topicMap = new Map(existing.map(t => [t.id, structuredClone(t)]));
  const merges: {from: string | number; into: string | number; title: string}[] = [];
  const canonical = new Map<string, InfoTask>();
  const result = tasks.map(t => labelInfoTask(t, root));
  for (const task of result) {
    const tags = task.tags as string[];
    const ids = tags.filter(t => t.startsWith('topic:')||t.startsWith('project:'));
    ids.forEach(id => { if (!topicMap.has(id)) topicMap.set(id, {id, title: id.slice(id.indexOf(':')+1), parentIds: []}); });
    task.parentIds = [...new Set([...(Array.isArray(task.parentIds) ? task.parentIds as string[] : []), ...ids])];
    if (task.mergedInto !== undefined) continue;
    const first = canonical.get(key(task.title));
    if (!first) { canonical.set(key(task.title), task); continue; }
    // Active executions remain independent until they settle.
    if ([first, task].some(t => t.status === 'in-progress' || t.executionSessionId)) continue;
    const evidence = (t: InfoTask) => [...(Array.isArray(t.sources) ? t.sources : []), ...(Array.isArray(t.originEvidence) ? t.originEvidence : []), ...(t.source ? [{source: t.source, taskId: t.id, due: t.due}] : [])];
    first.originEvidence = [...new Map([...evidence(first), ...evidence(task)].map(e => [JSON.stringify(e), e])).values()];
    first.sources = [...new Map([...(Array.isArray(first.sources) ? first.sources : []), ...(Array.isArray(task.sources) ? task.sources : [])].map(e => [JSON.stringify(e), e])).values()];
    first.tags = [...new Set([...(first.tags as string[]), ...tags])];
    first.parentIds = [...new Set([...(first.parentIds as string[]), ...(task.parentIds as string[])])];
    if (task.status === 'done') first.status = 'done';
    task.mergedInto = first.id; task.status = 'cancelled';
    merges.push({from: task.id, into: first.id, title: task.title});
  }
  const topics = [...topicMap.values()]; assertTopicGraph(topics);
  return { tasks: result, topics, merges };
}
