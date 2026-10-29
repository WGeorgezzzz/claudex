import { readdir, stat,readFile,writeFile,mkdir,rename } from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';

import { requireContextUserId, assertContextPath } from '@/modules/access-control/index.js';
import { sessionBridgeDb, monitorsDb, userPreferencesDb } from '@/modules/database/index.js';
import {getCloudCliHomeDir} from '@/shared/index.js';

import { infohubLifecycle, infohubRequest, infohubSyncStatus } from './taskmaster-infohub.service.js';
import { taskmasterInboxService } from './taskmaster-inbox.service.js';
import { taskmasterAutoService } from './taskmaster-auto.service.js';

type Source = { id: string; name: string; status: string; count: number; taskCount: number; lastSyncedAt: string | null; error: string | null; action?: string; note?: string; lastObservedAt?:string|null };
let reportsCache: { at: number; count: number; latest: string | null; error: string | null } | undefined;
async function reports() {
  if (reportsCache && Date.now() - reportsCache.at < 60000) return reportsCache;
  const root = process.env.TASKMASTER_REPORTS_ROOT || 'D:/embodied';
  let count = 0, latest = 0, error: string | null = null;
  try {
    assertContextPath(root);
    const dirs = (await readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()).slice(0,3000);
    for (let i = 0; i < dirs.length; i += 30) await Promise.all(dirs.slice(i,i+30).map(async dir => {
      for (const name of ['STATUS.md','DONE.json','REPORT_zh.md','CONCLUSION_zh.md']) {
        try { const file=path.join(root,dir.name,name);assertContextPath(file);const meta=await stat(file);if(meta.isFile()&&meta.size<=2000000){count++;latest=Math.max(latest,meta.mtimeMs);} } catch { /* Missing reports are normal. */ }
      }
    }));
  } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  reportsCache = { at: Date.now(), count, latest: latest ? new Date(latest).toISOString() : null, error };
  return reportsCache;
}

/** Native sources routes expose actual persisted evidence and upstream poll health without starting collectors or models. */
export const taskmasterSourcesService = {
  settings() {
    const saved = userPreferencesDb.getPreferences(requireContextUserId()).infohubLifecycle as { idleMinutes?: number } | undefined;
    return { idleMinutes: saved?.idleMinutes || 10 };
  },
  saveSettings(input: { idleMinutes: number }) {
    userPreferencesDb.savePreferences(requireContextUserId(), { infohubLifecycle: input });
    return infohubLifecycle.configure(input.idleMinutes);
  },
  start() { infohubLifecycle.configure(this.settings().idleMinutes); return infohubLifecycle.start(requireContextUserId()); },
  async snapshot() {
    const user = requireContextUserId(), global = await taskmasterInboxService.global();
    const tasks = global.projects.flatMap(p => p.tasks), sources: Source[] = [];
    const sessions = sessionBridgeDb.search('',100000,0).sessions;
    const automatic = taskmasterAutoService.settings(user).enabled;
    for (const provider of ['claude','codex']) {
      const rows = sessions.filter(row => row.provider === provider), ids = new Set(rows.map(row => row.sessionId));
      const linked = tasks.filter(task => (task.sources as { sessionId?: string }[] | undefined)?.some(s => ids.has(s.sessionId || '')));
      sources.push({ id:provider,name:provider==='claude'?'Claude 会话':'Codex 会话',status:automatic?'ready':'disabled',count:rows.length,taskCount:linked.length,
        lastSyncedAt:linked.map(t=>(t.autoUpdate as {at?:string}|undefined)?.at||'').filter(Boolean).sort().at(-1)||null,error:null,
        note:'会话索引；自动提取'+(automatic?'已启用':'已关闭')+'。索引数量不表示已完整提取。' });
    }
    const inventory = await reports();
    sources.push({ id:'reports',name:'任务目录报告',status:inventory.error?'error':'ready',count:inventory.count,taskCount:0,lastSyncedAt:inventory.latest,error:inventory.error,note:'STATUS / DONE / REPORT / CONCLUSION 按需检索证据；时间为最近文件更新，非导入时间。' });
    const monitors = monitorsDb.list(user,undefined,true);
    const runs = monitors.flatMap(m => monitorsDb.history(user,m.id)).filter(r => r.report);
    sources.push({id:'monitors',name:'监测汇报',status:'ready',count:runs.length,taskCount:0,lastSyncedAt:runs.map(r=>r.finished_at).filter((s):s is string=>typeof s==='string').sort().at(-1)||null,error:null,note:'通过监测会话和任务证据检索读取；不启动监测。'});
    let online = false, upstreamError: string | null = null;
    const cacheFile=path.join(getCloudCliHomeDir(),'taskmaster','infohub-observation-'+user+'-'+createHash('sha256').update(process.env.INFOHUB_BASE_URL||'http://127.0.0.1:8765').digest('hex').slice(0,12)+'.json');
    let cached: { latest: {layer?:string;source?:string;status?:string;stored?:number;finished_at?:number;error?:string}[]; counts:Record<string,number>;at:string|null }={latest:[],counts:{},at:null};
    try{cached=JSON.parse(await readFile(cacheFile,'utf8'));}catch{/* No prior upstream observation. */}
    let {latest,counts}=cached;
    // While collection holds the upstream API lock, return cached observations instead of blocking UI polling.
    if (!infohubLifecycle.busy()) try {
      const status = await infohubRequest('/api/status?limit=20',undefined,2000) as {latest?:typeof latest;totals?:{sources?:Record<string,number>}};
      online=true;latest=status.latest||[];counts=status.totals?.sources||{};
      cached={latest,counts,at:new Date().toISOString()};
      try{await mkdir(path.dirname(cacheFile),{recursive:true});const temporary=cacheFile+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(cached));await rename(temporary,cacheFile);}catch{/* Read-only status can still report live health when metadata storage is unavailable. */}
    } catch(cause) { upstreamError=cause instanceof Error?cause.message:String(cause); }
    else { online=infohubLifecycle.snapshot().progress.completed>=1; }
    const sync=infohubSyncStatus(user), runtime=infohubLifecycle.snapshot();
    sources.push({id:'infohub',name:'信息看板',status:runtime.phase==='starting'?'starting':runtime.phase==='error'?'error':online?'online':'stopped',count:tasks.filter(t=>t.source==='infohub').length,taskCount:tasks.filter(t=>t.source==='infohub').length,lastSyncedAt:sync.lastSyncedAt,error:runtime.error||(!online&&runtime.running?upstreamError:null),action:'start',note:'仅点击启动；空闲后退出自有进程。'});
    const names=[...new Set(['lark','wechat',...Object.keys(counts).map(s=>s.split(':')[0]),...latest.filter(r=>r.layer==='sync'&&r.source!=='all').map(r=>(r.source||'').split(':')[0])])].filter(Boolean);
    for(const name of names) {
      const records=latest.filter(r=>r.layer==='sync'&&(r.source===name||r.source?.startsWith(name+':')));
      const failed=records.filter(r=>r.status!=='ok');const error=failed.map(r=>[r.source,r.error||r.status].join(': ')).join('; ')||null;
      sources.push({id:name,name:name==='lark'?'飞书':name==='wechat'?'微信':name,status:!online?'offline':!records.length?'unknown':error?'error':'ready',count:Object.entries(counts).filter(([key])=>key===name||key.startsWith(name+':')).reduce((n,[,value])=>n+value,0),taskCount:tasks.filter(t=>(t.infohubEvidence as {source?:string}[]|undefined)?.some(e=>e.source===name)).length,lastSyncedAt:records.length?new Date(Math.max(...records.map(r=>(r.finished_at||0)*1000))).toISOString():null,lastObservedAt:cached.at,error:error||(!online?'信息看板未运行；启动后检查来源':!records.length?'尚无来源同步记录':null),note:(!online?'离线，显示上次观测；':'')+'count 为观测时近24小时消息数；时间为来源最近轮询（可能失败）。',...(error&&/token_missing|authorization|auth|login/i.test(error)?{action:'authorize',note:(!online?'离线，显示上次观测。':'')+'请在信息看板完成飞书用户授权，然后重新启动并同步；count 为观测时近24小时消息数。'}:error&&/not running|未运行/i.test(error)?{action:'open-wechat',note:(!online?'离线，显示上次观测。':'')+'请先打开并登录微信，再重新同步；count 为观测时近24小时消息数。'}:{})});
    }
    return { sources, infohub:{...runtime,online,lastSyncedAt:sync.lastSyncedAt,syncError:sync.error} };
  },
};
