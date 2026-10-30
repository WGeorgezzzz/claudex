// Isolated real-process test. Build first; credentials are copied locally, never printed.
// PROVIDER_SURVIVAL_BUILD points to dist-server; PROVIDER_SURVIVAL_RESULTS selects private output storage.
import {fileURLToPath,pathToFileURL} from 'node:url';import os from 'node:os';
const repository=path.dirname(fileURLToPath(new URL('../../package.json',import.meta.url)));
const build=path.resolve(process.env.PROVIDER_SURVIVAL_BUILD||path.join(repository,'dist-server'));
const moduleURL=relative=>pathToFileURL(path.join(build,relative)).href;
const results=process.env.PROVIDER_SURVIVAL_RESULTS||fs.mkdtempSync(path.join(os.tmpdir(),'nexagent-survival-'));fs.mkdirSync(results,{recursive:true});process.chdir(results);
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';import{spawn}from'node:child_process';import{createRequire}from'node:module';
const req=createRequire(path.join(repository,'package.json')),WS=req('ws'),jwt=req('jsonwebtoken');
const provider=process.argv[2]||'codex',port=Number(process.argv[3]||3238),root=path.resolve('evidence/monitor-'+provider+'-'+Date.now());fs.mkdirSync(root,{recursive:true});
const home=path.join(root,'home');fs.mkdirSync(home);const codexHome=path.join(root,'codex-home'),claudeHome=path.join(root,'claude-home');fs.mkdirSync(codexHome);fs.mkdirSync(claudeHome);
for(const [src,dest,files]of[[process.env.CODEX_HOME,codexHome,['config.toml','auth.json']],[process.env.CLAUDE_CONFIG_DIR,claudeHome,['settings.json','.credentials.json']]])for(const n of files)if(fs.existsSync(path.join(src,n)))fs.copyFileSync(path.join(src,n),path.join(dest,n));
const secret=crypto.randomBytes(32).toString('hex');process.env.DATABASE_PATH=path.join(root,'test.db');process.env.CLOUDCLI_HOME=home;
const db=await import(moduleURL('server/modules/database/index.js'));await db.initializeDatabase();const user=db.userDb.createUser('survival-web','unused');const session='survival-web-'+provider;db.sessionsDb.createAppSession(session,provider,root);db.closeConnection();
const token=jwt.sign({userId:user.id},secret,{expiresIn:'1h'}),base='http://127.0.0.1:'+port;
const env={SERVER_PORT:String(port),HOST:'127.0.0.1',CLOUDCLI_HOME:home,DATABASE_PATH:process.env.DATABASE_PATH,CODEX_HOME:codexHome,CLAUDE_CONFIG_DIR:claudeHome,JWT_SECRET:secret,CLAUDE_CLI_PATH:path.join(process.env.USERPROFILE,'.local','bin','claude.exe'),CLAUDEX_PASSIVE_INSTANCE:'0'};
const entry=path.join(root,'entry.mjs'),pidFile=path.join(root,'server.pid');
fs.writeFileSync(entry,`import fs from 'node:fs';Object.assign(process.env,${JSON.stringify(env)});delete process.env.NEXAGENT_PROVIDER_WORKER;delete process.env.API_KEY;fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));await import(${JSON.stringify(moduleURL('server/index.js'))});`);
const quote=s=>"'"+s.replaceAll("'","''")+"'",wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=180000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await wait(100);}throw Error('condition timeout '+root);}
async function api(ep,body){const r=await fetch(base+ep,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const text=await r.text();if(!r.ok)throw Error(ep+':'+r.status+':'+text);const json=JSON.parse(text);return json.data??json;}
async function start(){const script=`& ${quote(process.execPath)} ${quote(entry)} *>> ${quote(path.join(root,'server.log'))}`;const encoded=Buffer.from(script,'utf16le').toString('base64');const boot=`Start-Process -WindowStyle Hidden -FilePath "$env:SystemRoot/System32/conhost.exe" -ArgumentList @('--headless',"$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe",'-NoProfile','-NonInteractive','-EncodedCommand','${encoded}')`;const p=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(boot,'utf16le').toString('base64')],{windowsHide:true,stdio:'ignore'});await new Promise((res,rej)=>{p.on('exit',res);p.on('error',rej)});await until(async()=>{try{return(await fetch(base+'/health')).ok}catch{return false}},60000);return Number(fs.readFileSync(pidFile,'utf8'));}
function connect(){return new Promise((res,rej)=>{const ws=new WS('ws://127.0.0.1:'+port+'/ws?token='+token);ws.on('open',()=>res(ws));ws.on('error',rej);});}
const task=path.join(root,'ticks.cjs'),ticks=path.join(root,'ticks.log');fs.writeFileSync(task,`const fs=require('fs');let i=0;const t=setInterval(()=>{const s=(i++)+':中文🙂\\n';fs.appendFileSync(${JSON.stringify(ticks)},s);console.log(s.trim());if(i===20)clearInterval(t);},1000);`);
const prompt=`This is an isolated restart survival test. Run exactly once: node "${task}" . Wait until it finishes. Reply exactly WEB_SURVIVAL_DONE. Do not modify or inspect other files.`;

const realRuns=rows=>rows.filter(row=>!['heartbeat','skipped'].includes(row.status));
let pid,ws;const forwarded=[];try{
 pid=await start();
 const monitor=await api('/api/monitors',{sessionId:session,name:'[test] restart monitor receipt',content:prompt,intervalMinutes:60,options:{permissionMode:'bypassPermissions',runMode:'isolated'},probe:{intervalMinutes:3,heartbeatMinutes:180,items:[{type:'script',shell:'powershell',script:'# no output'}]}});
 await until(async()=>{const first=await api('/api/monitors/'+monitor.id+'/runs');return first.some(row=>row.status==='heartbeat')});
 await api('/api/monitors/'+monitor.id+'/action',{action:'run-now'});
 await until(()=>fs.existsSync(ticks)&&fs.readFileSync(ticks,'utf8').split('\n').length>=3);
 const originalRuns=realRuns(await api('/api/monitors/'+monitor.id+'/runs'));assert.equal(originalRuns.length,1);
 const handoff=await api('/api/providers/restart/prepare',{});assert.equal(handoff.sessions.length,1);const supervisor=handoff.sessions[0];
 const oldpid=pid;process.kill(pid,'SIGKILL');pid=undefined;await wait(500);pid=await start();ws=await connect();ws.on('message',value=>forwarded.push(JSON.parse(String(value))));ws.send(JSON.stringify({type:'chat.subscribe',sessions:[{sessionId:session}]}));
 await until(async()=>{const rows=realRuns(await api('/api/monitors/'+monitor.id+'/runs'));return rows[0]?.status==='succeeded'},180000);
 await until(()=>forwarded.some(e=>e.id==='monitor-report:'+originalRuns[0].id));const reports=forwarded.filter(e=>e.id==='monitor-report:'+originalRuns[0].id);assert.equal(reports.length,1);assert.equal(reports[0].sessionId,session);assert.ok(reports[0].content.includes('WEB_SURVIVAL_DONE'));const rows=realRuns(await api('/api/monitors/'+monitor.id+'/runs'));const detail=await api('/api/monitors/'+monitor.id);const receiptDb=new (req('better-sqlite3'))(path.join(root,'test.db'),{readonly:true});try{assert.equal(receiptDb.prepare('SELECT model_round_count n FROM monitors WHERE id=?').get(monitor.id).n,1)}finally{receiptDb.close()}
 assert.equal(rows.length,1);assert.equal(rows[0].id,originalRuns[0].id);assert.ok(rows[0].report.includes('WEB_SURVIVAL_DONE'));assert.ok(rows[0].total_tokens>0);
 const registry=JSON.parse(fs.readFileSync(path.join(home,'supervised-turns',supervisor.id,'registry.json')));assert.equal(registry.pid,supervisor.pid);
 const nativeEvents=fs.readFileSync(path.join(home,'supervised-turns',supervisor.id,'output.ndjson'),'utf8').trim().split('\n').map(s=>JSON.parse(s));assert.equal(nativeEvents.filter(e=>e.kind==='message'&&e.data.kind==='complete').length,1);
 const lines=fs.readFileSync(ticks,'utf8').trim().split('\n');assert.equal(lines.length,20);assert.equal(new Set(lines).size,20);
 await api('/api/monitors/'+monitor.id+'/action',{action:'stop'});process.kill(pid,'SIGKILL');pid=undefined;ws.close();ws=undefined;await wait(500);pid=await start();
 const after=realRuns(await api('/api/monitors/'+monitor.id+'/runs'));assert.equal(after.length,1);assert.equal(after[0].total_tokens,rows[0].total_tokens);
 fs.writeFileSync(path.join(root,'assertions.json'),JSON.stringify({pass:true,root,oldpid,newpid:pid,monitorId:monitor.id,detail,runs:rows,after,forwardedReports:reports,handoff,registry,lines:lines.length,terminalCount:1},null,2));console.log('PASS '+root);
}catch(error){fs.writeFileSync(path.join(root,'failure.json'),JSON.stringify({error:error.stack},null,2));throw error;}finally{ws?.close();if(pid)try{process.kill(pid,'SIGKILL')}catch{}}
