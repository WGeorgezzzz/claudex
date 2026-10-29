// Isolated real-process test. Build first; credentials are copied locally, never printed.
// PROVIDER_SURVIVAL_BUILD points to dist-server; PROVIDER_SURVIVAL_RESULTS selects private output storage.
import {fileURLToPath,pathToFileURL} from 'node:url';import os from 'node:os';
const repository=fileURLToPath(new URL('../../',import.meta.url));
const build=path.resolve(process.env.PROVIDER_SURVIVAL_BUILD||path.join(repository,'dist-server'));
const moduleURL=relative=>pathToFileURL(path.join(build,relative)).href;
const results=process.env.PROVIDER_SURVIVAL_RESULTS||fs.mkdtempSync(path.join(os.tmpdir(),'nexagent-survival-'));fs.mkdirSync(results,{recursive:true});process.chdir(results);
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';import{spawn}from'node:child_process';import{createRequire}from'node:module';
const req=createRequire(path.join(repository,'package.json')),WS=req('ws'),jwt=req('jsonwebtoken');
const provider=process.argv[2]||'codex',port=Number(process.argv[3]||3238),root=path.resolve('evidence/permissions-'+provider+'-'+Date.now());fs.mkdirSync(root,{recursive:true});
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
const prompt=`This is an isolated restart survival test. First use AskUserQuestion to ask exactly "Continue the restart survival test?" with options "Yes" and "No". Wait for the answer. If Yes, run exactly once: node "${task}" . Wait until it finishes. Reply exactly WEB_SURVIVAL_DONE. Do not modify or inspect other files.`;
let pid,ws,ws2;const before=[],after=[];
try{
 pid=await start();ws=await connect();ws.on('message',s=>before.push(JSON.parse(String(s))));ws.send(JSON.stringify({type:'chat.subscribe',sessions:[{sessionId:session}]}));
 const queued=await api('/api/message-queue',{sessionId:session,requestId:'web-survival-original',content:prompt,options:{permissionMode:'bypassPermissions',...(provider==='claude'?{model:'sonnet'}:{})}});
 await until(()=>before.some(e=>e.kind==='permission_request')); const permissionBefore=before.find(e=>e.kind==='permission_request');
 const handoff=await api('/api/providers/restart/prepare',{});assert.equal(handoff.ready,true);assert.equal(handoff.sessions.length,1);
 const supervisor=handoff.sessions[0];const oldpid=pid;process.kill(pid,'SIGKILL');pid=undefined;ws.close();await wait(500);
 pid=await start();assert.notEqual(pid,oldpid);ws2=await connect();ws2.on('message',s=>after.push(JSON.parse(String(s))));ws2.send(JSON.stringify({type:'chat.subscribe',sessions:[{sessionId:session,lastSeq:0}]}));
 await until(()=>after.some(e=>e.kind==='chat_subscribed'&&e.sessionId===session&&e.pendingPermissions?.length));const pending=after.find(e=>e.kind==='chat_subscribed'&&e.pendingPermissions?.length).pendingPermissions;assert.equal(pending[0].requestId,permissionBefore.requestId);const question=pending[0].input.questions[0].question;ws2.send(JSON.stringify({type:'chat.permission-response',requestId:pending[0].requestId,allow:true,updatedInput:{answers:{[question]:'Yes'}}}));await until(()=>after.some(e=>e.kind==='complete'&&e.sessionId===session),180000);
 const rows=await api('/api/message-queue?sessionId='+session);const attempts=await api('/api/message-queue/'+queued.id+'/attempts');
 const registry=JSON.parse(fs.readFileSync(path.join(home,'supervised-turns',supervisor.id,'registry.json')));
 const lines=fs.readFileSync(ticks,'utf8').trim().split('\n');assert.equal(lines.length,20);assert.equal(new Set(lines).size,20);assert.equal(registry.pid,supervisor.pid);
 assert.equal(after.filter(e=>e.kind==='complete'&&e.sessionId===session).length,1);assert.ok(JSON.stringify(after).includes('WEB_SURVIVAL_DONE'));assert.equal(rows.find(r=>r.id===queued.id).status,'succeeded');assert.equal(attempts.length,1);assert.equal(attempts[0].status,'succeeded');
 assert.equal(rows.filter(r=>r.content==='服务已重启，继续上一步').length,0);
 fs.writeFileSync(path.join(root,'events-before.json'),JSON.stringify(before,null,2));fs.writeFileSync(path.join(root,'events-after.json'),JSON.stringify(after,null,2));
 fs.writeFileSync(path.join(root,'assertions.json'),JSON.stringify({pass:true,root,provider,oldpid,newpid:pid,handoff,registry,lines:lines.length,queueStatus:rows.find(r=>r.id===queued.id).status,attempts,terminalCount:1,noFallback:true},null,2));console.log('PASS '+root);
}catch(e){fs.writeFileSync(path.join(root,'failure.json'),JSON.stringify({error:e.stack,before,after},null,2));throw e;}
finally{ws?.close();ws2?.close();if(pid)try{process.kill(pid,'SIGKILL')}catch{};}




