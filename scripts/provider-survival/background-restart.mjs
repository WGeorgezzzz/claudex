// Isolated real-process test. Build first; credentials are copied locally, never printed.
// PROVIDER_SURVIVAL_BUILD points to dist-server; PROVIDER_SURVIVAL_RESULTS selects private output storage.
import {fileURLToPath,pathToFileURL} from 'node:url';import os from 'node:os';
const repository=path.dirname(fileURLToPath(new URL('../../package.json',import.meta.url)));
const build=path.resolve(process.env.PROVIDER_SURVIVAL_BUILD||path.join(repository,'dist-server'));
const moduleURL=relative=>pathToFileURL(path.join(build,relative)).href;
const results=process.env.PROVIDER_SURVIVAL_RESULTS||fs.mkdtempSync(path.join(os.tmpdir(),'nexagent-survival-'));fs.mkdirSync(results,{recursive:true});process.chdir(results);
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';import{spawn}from'node:child_process';import{createRequire}from'node:module';
const req=createRequire(path.join(repository,'package.json')),WS=req('ws'),jwt=req('jsonwebtoken');
const provider=process.argv[2]||'codex',port=Number(process.argv[3]||3238),root=path.resolve('evidence/background-'+provider+'-'+Date.now());fs.mkdirSync(root,{recursive:true});
const home=path.join(root,'home');fs.mkdirSync(home);const codexHome=path.join(root,'codex-home'),claudeHome=path.join(root,'claude-home');fs.mkdirSync(codexHome);fs.mkdirSync(claudeHome);
for(const [src,dest,files]of[[process.env.CODEX_HOME,codexHome,['config.toml','auth.json']],[process.env.CLAUDE_CONFIG_DIR,claudeHome,['settings.json','.credentials.json']]])for(const n of files)if(fs.existsSync(path.join(src,n)))fs.copyFileSync(path.join(src,n),path.join(dest,n));
const secret=crypto.randomBytes(32).toString('hex');process.env.DATABASE_PATH=path.join(root,'test.db');process.env.CLOUDCLI_HOME=home;
const db=await import(moduleURL('server/modules/database/index.js'));await db.initializeDatabase();const user=db.userDb.createUser('survival-web','unused');let session;db.closeConnection();
const token=jwt.sign({userId:user.id},secret,{expiresIn:'1h'}),base='http://127.0.0.1:'+port;
const env={SERVER_PORT:String(port),HOST:'127.0.0.1',CLOUDCLI_HOME:home,DATABASE_PATH:process.env.DATABASE_PATH,CODEX_HOME:codexHome,CLAUDE_CONFIG_DIR:claudeHome,JWT_SECRET:secret,CLAUDE_CLI_PATH:path.join(process.env.USERPROFILE,'.claude-cc','boxed','claude.exe'),CLAUDEX_PASSIVE_INSTANCE:'0'};
const entry=path.join(root,'entry.mjs'),pidFile=path.join(root,'server.pid');
fs.writeFileSync(entry,`import fs from 'node:fs';Object.assign(process.env,${JSON.stringify(env)});delete process.env.NEXAGENT_PROVIDER_WORKER;delete process.env.API_KEY;fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));await import(${JSON.stringify(moduleURL('server/index.js'))});`);
const quote=s=>"'"+s.replaceAll("'","''")+"'",wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=180000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await wait(100);}throw Error('condition timeout '+root);}
async function api(ep,body){const r=await fetch(base+ep,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const text=await r.text();if(!r.ok)throw Error(ep+':'+r.status+':'+text);const json=JSON.parse(text);return json.data??json;}
async function start(){const script=`& ${quote(process.execPath)} ${quote(entry)} *>> ${quote(path.join(root,'server.log'))}`;const encoded=Buffer.from(script,'utf16le').toString('base64');const boot=`Start-Process -WindowStyle Hidden -FilePath "$env:SystemRoot/System32/conhost.exe" -ArgumentList @('--headless',"$env:SystemRoot/System32/WindowsPowerShell/v1.0/powershell.exe",'-NoProfile','-NonInteractive','-EncodedCommand','${encoded}')`;const p=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(boot,'utf16le').toString('base64')],{windowsHide:true,stdio:'ignore'});await new Promise((res,rej)=>{p.on('exit',res);p.on('error',rej)});await until(async()=>{try{return(await fetch(base+'/health')).ok}catch{return false}},60000);return Number(fs.readFileSync(pidFile,'utf8'));}
function connect(){return new Promise((res,rej)=>{const ws=new WS('ws://127.0.0.1:'+port+'/ws?token='+token);ws.on('open',()=>res(ws));ws.on('error',rej);});}

const task=path.join(root,'background.cjs'),ticks=path.join(root,'ticks.log');
fs.writeFileSync(task,'const fs=require("fs");let i=0;const t=setInterval(()=>{fs.appendFileSync('+JSON.stringify(ticks)+',String(i++)+"\\n");if(i===180)clearInterval(t)},1000)');
let pid,ws,ws2;const before=[],after=[];
async function queue(content,id){return api('/api/message-queue',{sessionId:session,requestId:id,content,options:{permissionMode:'bypassPermissions',model:'sonnet'}})}
try{
 pid=await start();session=(await api('/api/providers/sessions',{provider,projectPath:root})).sessionId;
 ws=await connect();ws.on('message',s=>before.push(JSON.parse(String(s))));ws.send(JSON.stringify({type:'chat.subscribe',sessions:[{sessionId:session}]}));
 await queue('Run exactly once with Bash run_in_background=true: node "'+task+'" . Leave it running in the background and reply exactly BACKGROUND_READY. Do not wait for it.','background-first');
 const subscribeTimer=setInterval(()=>{if(ws.readyState===1)ws.send(JSON.stringify({type:'chat.subscribe',sessions:[{sessionId:session,lastSeq:0}]}))},1000);subscribeTimer.unref();
 await until(()=>before.some(e=>e.kind==='complete'&&e.sessionId===session));
 clearInterval(subscribeTimer);assert(JSON.stringify(before).includes('BACKGROUND_READY'));assert(fs.existsSync(ticks));
 const handoff=await api('/api/providers/restart/prepare',{});assert.equal(handoff.sessions.length,1);
 const original=handoff.sessions[0];await api('/api/providers/restart/cancel',{handoffId:handoff.handoffId});
 await queue('Do not stop the background job. Run a foreground Bash command that waits 25 seconds, then reply exactly SECOND_FOREGROUND_OK.','background-second');
 await wait(7000);const h2=await api('/api/providers/restart/prepare',{});assert.equal(h2.sessions[0].pid,original.pid);
 process.kill(pid,'SIGKILL');pid=undefined;ws.close();await wait(500);pid=await start();
 ws2=await connect();ws2.on('message',s=>after.push(JSON.parse(String(s))));ws2.send(JSON.stringify({type:'chat.subscribe',sessions:[{sessionId:session,lastSeq:0}]}));
 await until(()=>JSON.stringify(after).includes('SECOND_FOREGROUND_OK'));
 await queue('Do not use tools. Reply exactly THIRD_FOREGROUND_OK.','background-third');
 await until(()=>JSON.stringify(after).includes('THIRD_FOREGROUND_OK'));
 const rows=await api('/api/message-queue?sessionId='+session);assert(rows.filter(r=>r.status==='succeeded').length===3);
 const registry=JSON.parse(fs.readFileSync(path.join(home,'supervised-turns',original.id,'registry.json')));assert.equal(registry.pid,original.pid);
 fs.writeFileSync(path.join(root,'assertions.json'),JSON.stringify({pass:true,sessionId:session,sameWorker:true,pid:original.pid,queue:rows.map(r=>({requestId:r.request_id,status:r.status,attempts:r.attempt_count}))},null,2));console.log('PASS '+root);
}catch(e){fs.writeFileSync(path.join(root,'failure.json'),JSON.stringify({error:e.stack,before,after},null,2));throw e;}
finally{
 ws?.close();ws2?.close();if(pid)try{process.kill(pid,'SIGKILL')}catch{};
 // Only this fixture's authenticated supervisors may be stopped.
 const dir=path.join(home,'supervised-turns');if(fs.existsSync(dir))for(const name of fs.readdirSync(dir)){
  try{const d=path.join(dir,name),r=JSON.parse(fs.readFileSync(path.join(d,'registry.json'))),t=fs.readFileSync(path.join(d,'token'),'utf8');await fetch('http://127.0.0.1:'+r.port+'/control',{method:'POST',headers:{Authorization:'Bearer '+t,'Content-Type':'application/json'},body:JSON.stringify({type:'force-stop'}),signal:AbortSignal.timeout(10000)});}catch{}
 }
}
