'use strict';
const {partitionDeploymentSessions}=require('./running-session-ownership.cjs');
const {createProviderHandoff}=require('./provider-handoff.cjs');
let providerHandoff;
// Prepared only. No production mutation occurs without an explicit --activate or --rollback argument.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process'),{createRequire}=require('node:module');
const arg=name=>process.argv.includes(name)?process.argv[process.argv.indexOf(name)+1]:undefined,source=path.resolve(arg('--source')||process.cwd()),target=path.resolve(arg('--release')||path.join(source,'../release-1')),root=path.dirname(target),req=createRequire(path.join(target,'package.json')),DB=req('better-sqlite3');
const cfgPath='D:/embodied/claudex-dot-20261023/primary-service.json',app='C:/Users/73505/AppData/Local/Programs/Claudex-local-0.8.0/resources/app',link=path.join(app,'server'),desktop=path.join(app,'dist'),task='Claudex-Primary-Service-3001';
const ps=s=>execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',s],{encoding:'utf8',windowsHide:true,timeout:30000});
const quote=s=>"'"+String(s).replaceAll("'","''")+"'",norm=p=>path.resolve(p).toLowerCase(),read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n','utf8');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function check(){
 releaseGuard();desktopShellCheck();const c=read(cfgPath),manifest=read(path.join(target,'release-manifest.json'));assert.equal(c.port,3001);assert.equal(norm(fs.realpathSync(link)),norm(c.runtime));
 for(const [file,hash]of Object.entries(manifest.hashes)){assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(target,file))).digest('hex'),hash,'Release checksum mismatch: '+file);}

 for(const name of ['dist','dist-server','public','scripts','server','shared','package.json','package-lock.json','frontend-release.json'])assert(fs.existsSync(path.join(target,name)),name+' missing');
 if(norm(c.runtime)!==norm(target)){const old=read(path.join(c.runtime,'release-manifest.json'));execFileSync('git',['merge-base','--is-ancestor',old.git,manifest.git],{cwd:source});}
 execFileSync('git',['merge-base','--is-ancestor','64a59410',manifest.git],{cwd:source});
 const db=new DB(c.database,{readonly:true,fileMustExist:true});assert.equal(db.pragma('quick_check',{simple:true}),'ok');db.close();
 const listeners=JSON.parse(ps('@(Get-NetTCPConnection -State Listen -LocalPort 3001 | Select-Object -ExpandProperty OwningProcess -Unique) | ConvertTo-Json -Compress'));const ids=Array.isArray(listeners)?listeners:[listeners];
 return {status:'prepared',target,git:manifest.git,currentRuntime:c.runtime,port:3001,requiresRestart:true,productionChanged:false,activationPreflight:{ready:ids.length===1&&ids[0]===c.pid,configuredPid:c.pid,listeningPids:ids,reason:ids.length===1&&ids[0]===c.pid?null:'Primary-service PID and actual listener differ; activation will refuse before stopping anything.'}};
}


let loginCache;
async function login(c){
 if(loginCache?.pid===c.pid)return loginCache.token;
 const base='http://127.0.0.1:3001',key=fs.readFileSync(path.join(c.home,'local-identity.key'),'utf8').trim();
 const r=await fetch(base+'/api/auth/local-ticket',{method:'POST',headers:{'x-claudex-local-key':key},signal:AbortSignal.timeout(10000)});
 if(r.status===429)throw Error('WAIT: local authentication rate limit');assert(r.ok,'Local authentication failed');const {ticket}=await r.json();assert(ticket);
 const exchanged=await fetch(base+'/api/auth/local-exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket}),signal:AbortSignal.timeout(10000)});
 if(exchanged.status===429)throw Error('WAIT: local authentication rate limit');assert(exchanged.ok);const {token}=await exchanged.json();assert(token);loginCache={pid:c.pid,token};return token;
}
async function idle(c){
 const latest=read(cfgPath);assert.equal(latest.pid,c.pid,'Primary process changed');assert.equal(norm(latest.runtime),norm(c.runtime));assert.equal(norm(fs.realpathSync(link)),norm(c.runtime));
 const token=await login(c),response=await fetch('http://127.0.0.1:3001/api/providers/sessions/running',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(600000)});assert(response.ok);const running=await response.json();assert(Array.isArray(running.data?.sessions),'Unrecognized running-session response');const ownership=partitionDeploymentSessions(running.data.sessions);write(path.join(root,'running-sessions-before-activation.json'),ownership.managed);if(process.argv.includes('--force')){fs.mkdirSync(path.join(root,'evidence'),{recursive:true});write(path.join(root,'evidence/force-switch-running-sessions.json'),{at:new Date().toISOString(),sessions:ownership.managed,independent:ownership.independent});}write(path.join(root,'independent-sessions-before-activation.json'),ownership.independent);fs.appendFileSync(path.join(root,'STATUS.md'),'\n- 激活前正在运行的会话数：'+ownership.managed.length+'，详见 running-sessions-before-activation.json。仅在会话和队列空闲后激活。\n');
 const db=new DB(c.database,{readonly:true});try{const n=db.prepare("SELECT COUNT(*) n FROM message_queue WHERE status IN ('running','processing','executing')").get().n;write(path.join(root,'running-queue-before-activation.json'),{count:n});}finally{db.close();}
 const p=JSON.parse(ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(c.pid)}'; [pscustomobject]@{pid=$p.ProcessId;command=$p.CommandLine;children=@(Get-CimInstance Win32_Process | Where-Object ParentProcessId -eq ${Number(c.pid)}).Count;listeners=@(Get-NetTCPConnection -State Listen -LocalPort 3001 | Select-Object -ExpandProperty OwningProcess -Unique)} | ConvertTo-Json -Compress`));
 assert.equal(p.pid,c.pid);assert(p.command.replaceAll('\\','/').toLowerCase().includes(c.runtime.replaceAll('\\','/').toLowerCase()));assert.deepEqual(p.listeners,[c.pid]);
}
async function stop(c){
 const tree=await import(require('node:url').pathToFileURL(path.join(target,'dist-server/server/shared/process-tree.js')).href);
 const descendants=await tree.listDescendants(c.pid);
 const providerRoots=JSON.parse(ps("@(Get-CimInstance Win32_Process | Where-Object { @("+descendants.join(',')+") -contains $_.ProcessId -and ($_.Name -match '^(claude|codex)(\\.exe)?$' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'codex[/\\\\]bin|codex\\.js')) } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress")||'[]');
 const captures=await Promise.all((Array.isArray(providerRoots)?providerRoots:[providerRoots]).map(async pid=>({pid,children:await tree.listDescendants(pid)})));

 assert.equal(captures.length,0,'Legacy provider descendants cannot survive a task stop; wait idle instead of killing them');
 await providerHandoff?.confirm();
 ps(`Stop-ScheduledTask -TaskName ${quote(task)}`);
 ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(c.pid)}'; if($p){ if(-not $p.CommandLine.Replace('\\','/').ToLowerInvariant().Contains(${quote(c.runtime.replaceAll('\\','/').toLowerCase())})){throw 'Unexpected production process'}; Stop-Process -Id ${Number(c.pid)}}`);

 write(path.join(root,'provider-shutdown.json'),{at:new Date().toISOString(),serverPid:c.pid,captures});
 assert.equal(ps('@(Get-NetTCPConnection -State Listen -LocalPort 3001 -ErrorAction SilentlyContinue).Count').trim(),'0','Production port remains occupied');
}
async function start(){ps(`Start-ScheduledTask -TaskName ${quote(task)}`);for(let i=0;i<90;i++){try{if((await fetch('http://127.0.0.1:3001/health',{signal:AbortSignal.timeout(1000)})).ok){const c=read(cfgPath);const listener=JSON.parse(ps("Get-NetTCPConnection -State Listen -LocalPort 3001 | Select-Object -ExpandProperty OwningProcess -Unique | ConvertTo-Json -Compress"));assert(Number.isInteger(listener));const command=ps(`(Get-CimInstance Win32_Process -Filter 'ProcessId = ${listener}').CommandLine`);assert(command.replaceAll('\\','/').toLowerCase().includes(c.runtime.replaceAll('\\','/').toLowerCase()));write(cfgPath,{...c,pid:listener});return read(cfgPath);}}catch{}if(i===10)ps(`Start-Process -FilePath 'C:/Windows/System32/conhost.exe' -ArgumentList '--headless',${quote('D:/embodied/claudex-console-20261022/ClaudexHidden.exe')},${quote('D:/embodied/claudex-dot-20261023/primary-launcher.json')}`);await pause(500);}throw Error('Production startup timed out');}
function recordIds(db){const tables={};for(const name of ['users','projects','sessions','monitors','message_queue','api_keys','provider_models','user_preferences']){
 const pk=db.prepare(`PRAGMA table_info("${name}")`).all().filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);if(pk.length)tables[name]=db.prepare(`SELECT ${pk.map(c=>'"'+c+'"').join(',')} FROM "${name}"`).all().map(v=>JSON.stringify(v)).sort();}return tables;}
function replaceLink(dest){assert(fs.lstatSync(link).isSymbolicLink(),'Runtime path must be a junction');const previous=fs.realpathSync(link);fs.unlinkSync(link);try{fs.symlinkSync(dest,link,'junction');}catch(error){fs.symlinkSync(previous,link,'junction');throw error;}}

function desktopShellCheck() {
 const manifest=read(path.join(target,'desktop-shell-manifest.json'));
 for(const entry of manifest.files){
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(target,'desktop-shell',entry.file))).digest('hex'),entry.sha256,entry.file);
  const current=path.join(app,entry.file),hash=fs.existsSync(current)?crypto.createHash('sha256').update(fs.readFileSync(current)).digest('hex'):null;
  assert(hash===entry.originalSha256||hash===entry.sha256,'Installed desktop shell drifted: '+entry.file);
 }
}
function desktopShellUpdate(backup){
 desktopShellCheck();const manifest=read(path.join(target,'desktop-shell-manifest.json'));
 const state=manifest.files.map(entry=>({file:entry.file,existed:fs.existsSync(path.join(app,entry.file))}));
 for(const entry of state)if(entry.existed){const saved=path.join(backup,'desktop-shell',entry.file);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(path.join(app,entry.file),saved);}
 write(path.join(backup,'desktop-shell-state.json'),state);
 for(const entry of state){const dest=path.join(app,entry.file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(target,'desktop-shell',entry.file),dest+'.agenthub-next');fs.renameSync(dest+'.agenthub-next',dest);}
}
function desktopShellRestore(backup){
 const stateFile=path.join(backup,'desktop-shell-state.json');if(!fs.existsSync(stateFile))return;
 for(const entry of read(stateFile)){const dest=path.join(app,entry.file);if(entry.existed){fs.copyFileSync(path.join(backup,'desktop-shell',entry.file),dest+'.agenthub-next');fs.renameSync(dest+'.agenthub-next',dest);}else if(fs.existsSync(dest))fs.unlinkSync(dest);}
}

function desktopUpdate(backup){
 fs.cpSync(desktop,path.join(backup,'desktop-dist'),{recursive:true});const marker=path.join(app,'frontend-release.json');if(fs.existsSync(marker))fs.copyFileSync(marker,path.join(backup,'frontend-release.json'));
 fs.writeFileSync(path.join(backup,'desktop-backup-ready'),'ready\n');
 const src=path.join(target,'dist');for(const name of fs.readdirSync(src))if(name!=='index.html')fs.cpSync(path.join(src,name),path.join(desktop,name),{recursive:true});
 fs.copyFileSync(path.join(src,'index.html'),path.join(desktop,'index.html.next'));fs.renameSync(path.join(desktop,'index.html.next'),path.join(desktop,'index.html'));fs.copyFileSync(path.join(target,'frontend-release.json'),marker);desktopShellUpdate(backup);
}
function desktopRestore(backup){desktopShellRestore(backup);const saved=path.join(backup,'desktop-dist');if(!fs.existsSync(path.join(backup,'desktop-backup-ready')))return;for(const name of fs.readdirSync(saved))if(name!=='index.html')fs.cpSync(path.join(saved,name),path.join(desktop,name),{recursive:true});fs.copyFileSync(path.join(saved,'index.html'),path.join(desktop,'index.html.next'));fs.renameSync(path.join(desktop,'index.html.next'),path.join(desktop,'index.html'));if(fs.existsSync(path.join(backup,'frontend-release.json')))fs.copyFileSync(path.join(backup,'frontend-release.json'),path.join(app,'frontend-release.json'));}
async function verify(c,before){
 check();
 const token=await login(c),get=async endpoint=>{const r=await fetch('http://127.0.0.1:3001'+endpoint,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});assert(r.ok,endpoint+' failed');return r.json();};
 const org=await get('/api/project-organization');assert(Array.isArray(org.data?.projects));
 const caps=await get('/api/providers/capabilities');assert(caps.data.providers.some(p=>p.provider==='codex'));
 const users=await get('/api/auth/users');assert(Array.isArray(users.users));
 const db=new DB(c.database,{readonly:true});try{const after=recordIds(db);for(const [table,ids]of Object.entries(before)){assert(after[table],table+' missing');const retained=new Set(after[table]);for(const id of ids)assert(retained.has(id),table+' lost an existing record');}assert.equal(db.pragma('quick_check',{simple:true}),'ok');assert(db.prepare("SELECT name FROM sqlite_master WHERE name='usage_scan_files'").get());for(const name of ['quota_credit_snapshots','quota_credit_alerts'])assert(db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(name));const columns=db.prepare('PRAGMA table_info(sessions)').all().map(c=>c.name);for(const column of ['title_source','title_auto_attempted','title_revision'])assert(columns.includes(column),'Missing title migration '+column);}finally{db.close();}
 const frontend=await fetch('http://127.0.0.1:3001/',{signal:AbortSignal.timeout(10000)});assert(frontend.ok);assert.equal(await frontend.text(),fs.readFileSync(path.join(target,'dist/index.html'),'utf8'));
 const missing=await fetch('http://127.0.0.1:3001/api/providers/sessions/title-deploy-check-missing/regenerate-title',{method:'POST',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});assert.equal(missing.status,404,'Title route not installed or unauthorized');
 return {authenticatedBusiness:true,recordIdsPreserved:true,frontendMatched:true,modelCapabilities:true,releaseChecksums:true};
}
async function rollback(backup){
 backup=path.resolve(backup);assert(backup.startsWith(path.resolve(root)+path.sep),'Backup must be inside this task directory');const original=read(path.join(backup,'primary-service.json')),current=read(cfgPath);
 assert.equal(norm(current.runtime),norm(target),'Refuse to roll back a different deployment');await interruptManaged(current);await stop(current);replaceLink(original.runtime);write(cfgPath,original);desktopRestore(backup);const c=await start();write(path.join(path.dirname(cfgPath),'active-release.json'),{status:'rolled_back',commit:read(path.join(c.runtime,'release-manifest.json')).git,runtime:c.runtime,pid:c.pid,at:new Date().toISOString()});write(path.join(root,'deployment-status.json'),{status:'rolled_back',backup,runtime:c.runtime,pid:c.pid,databaseRestored:false,reason:'Current database and later writes are preserved; additive quota history tables are retained',at:new Date().toISOString()});
}
async function activate(){
 check();const c=read(cfgPath);if(norm(c.runtime)===norm(target))throw Error('Target is already active; inspect deployment-status.json');if(!process.argv.includes('--force'))await waitIdle(c);
 const backup=path.join(root,'activation-backup-'+new Date().toISOString().replaceAll(':','-'));fs.mkdirSync(backup);fs.copyFileSync(cfgPath,path.join(backup,'primary-service.json'));
 const linkBefore=fs.realpathSync(link);write(path.join(backup,'runtime.json'),{runtime:linkBefore,release:read(path.join(c.runtime,'release-manifest.json'))});
 await idle(c);let stopped=false,changed=false;
 try{
  // SQLite online backup includes supervised workers, which retain their DB connections.
  check();await interruptManaged(c);stopped=true;await stop(c);const db=new DB(c.database,{readonly:true});let ids;try{ids=recordIds(db);await db.backup(path.join(backup,'database.db'));}finally{db.close();}write(path.join(backup,'record-ids.json'),ids);
  replaceLink(target);changed=true;write(cfgPath,{...c,runtime:target});const current=await start(),checks=await verify(current,ids);desktopUpdate(backup);
  const result={commit:read(path.join(target,'release-manifest.json')).git,status:'active',runtime:target,pid:current.pid,previousRuntime:c.runtime,backup,checks,at:new Date().toISOString()};write(path.join(path.dirname(cfgPath),'active-release.json'),result);write(path.join(root,'deployment-status.json'),result);console.log(JSON.stringify(result));
 }catch(error){
  let rollbackError;
  try{if(changed){const current=read(cfgPath);await stop(current);replaceLink(c.runtime);write(cfgPath,c);desktopRestore(backup);}if(stopped)await start();}catch(e){rollbackError=e.message;}
  write(path.join(root,'deployment-status.json'),{status:rollbackError?'rollback_failed':'rolled_back',backup,error:error.message,rollbackError,databaseRestored:false,at:new Date().toISOString()});throw error;
 }
}

function releaseGuard(){
 const git=(...args)=>execFileSync('git',args,{cwd:source,encoding:'utf8',windowsHide:true}).trim();
 git('fetch','origin');
 assert.equal(git('status','--porcelain'),'','Deployment source must be clean');
 const manifest=read(path.join(target,'release-manifest.json'));
 assert.equal(manifest.git,git('rev-parse','origin/main'),'Release must equal current origin/main');
 assert.equal(manifest.git,git('rev-parse','HEAD'),'Source and release differ');
 assert.equal(read(path.join(target,'build-provenance.json')).git,manifest.git,'Build provenance differs');
 const c=read(cfgPath),old=read(path.join(c.runtime,'release-manifest.json'));
 git('merge-base','--is-ancestor',old.git,manifest.git);
 const concat=folder=>fs.readdirSync(folder,{recursive:true}).filter(name=>/\.(js|html)$/.test(name)).map(name=>fs.readFileSync(path.join(folder,name),'utf8')).join('\n');
 const client=concat(path.join(target,'dist')),backend=concat(path.join(target,'dist-server'));
 for(const marker of ['/tasks','任务','打开所在文件夹'])assert(client.includes(marker),'Client marker missing: '+marker);
 for(const marker of ['forceStop','providerSessionId','findResumedProviderProcesses','mcp__claudex_sessions__session'])assert(backend.includes(marker),'Backend marker missing: '+marker);
}
async function running(c){const token=await login(c);const r=await fetch('http://127.0.0.1:3001/api/providers/sessions/running',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(600000)});assert(r.ok);const ownership=partitionDeploymentSessions((await r.json()).data.sessions);write(path.join(root,'independent-sessions-before-activation.json'),ownership.independent);return ownership.managed;}
async function waitIdle(c){const minutes=Number(arg('--idle-timeout-minutes')||120);assert(Number.isInteger(minutes)&&minutes>=1&&minutes<=120,'Idle timeout must be 1–120 minutes');const started=Date.now();for(;;){const rows=await running(c);write(path.join(root,'running-sessions-before-activation.json'),rows);const db=new DB(c.database,{readonly:true});let queue;try{queue=db.prepare("SELECT id,status FROM message_queue WHERE status IN ('running','processing','executing')").all();}finally{db.close();}write(path.join(root,'running-queue-before-activation.json'),queue);if(!rows.length&&!queue.length)return;if(Date.now()-started>=minutes*60*1000)throw Error('Idle timeout; no sessions interrupted');console.log('Waiting for idle:',rows.length);await pause(15000);}}
async function interruptManaged(c){
 if(process.argv.includes('--force')){
  // First upgrade from a release without handoff endpoints is safe only idle.
  const rows=await running(c);
  const db=new DB(c.database,{readonly:true});let queued;
  try{queued=db.prepare("SELECT COUNT(*) n FROM message_queue WHERE status IN ('running','processing','executing')").get().n;}finally{db.close();}
  return forceInterruptManaged(c,rows.length===0&&queued===0);
 }
 // The caller may stop only an idle server. Never abort user/provider work.
 const rows=await running(c);assert.equal(rows.length,0,'Sessions became active; activation cancelled');
 const db=new DB(c.database,{readonly:true});try{assert.equal(db.prepare("SELECT COUNT(*) n FROM message_queue WHERE status IN ('running','processing','executing')").get().n,0,'Queue became active; activation cancelled');}finally{db.close();}
 await forceInterruptManaged(c,true);
}

async function forceInterruptManaged(c,allowIdleLegacy=false){
 const token=await login(c);
 providerHandoff=createProviderHandoff(async(operation,body)=>{
  const response=await fetch('http://127.0.0.1:3001/api/providers/restart/'+operation,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(operation==='prepare'?60000:5000)});
  if(response.status===404)return null;
  assert(response.ok,'Provider '+operation+' handshake failed; legacy turns must not be aborted.');
  return (await response.json()).data;
 },{onError:error=>console.error('Provider handoff recovery/renewal:',error.message)});
 const evidence=await providerHandoff.prepare(allowIdleLegacy);
 if(evidence)write(path.join(root,'provider-handoff.json'),evidence);
}
async function main(){
 const lock=path.join(path.dirname(cfgPath),'nexagent-deploy.lock');
 const fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,source,target,at:new Date().toISOString()}));
 try{
  if(process.argv.includes('--rollback')){await rollback(arg('--rollback'));return;}
  if(!process.argv.includes('--activate')){console.log(JSON.stringify(check(),null,2));return;}
  await activate();
 }finally{await providerHandoff?.cancel();fs.closeSync(fd);fs.unlinkSync(lock);}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
