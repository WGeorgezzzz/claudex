import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// This exercises a generated installer on a disposable Windows CI machine.
// It must never fabricate an "upstream" installation on a user's workstation.
if (process.platform!=='win32' || process.env.CI!=='true') throw new Error('Run installer acceptance only on a disposable Windows CI runner.');
const installDirectory=path.resolve(process.argv[2]||'');
const reportPath=path.resolve(process.argv[3]||'release/workbench/installer-smoke.json');
const executable=path.join(installDirectory,'GACI.exe');
await fs.access(executable);
const profileDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-acceptance-'));
const sentinelDatabase=path.join(profileDirectory,'existing-service.db');
const sentinelContents='existing service must remain untouched';
await fs.writeFile(sentinelDatabase,sentinelContents);
let sentinelRequests=0, appProcess, ownedServerPid;
const sentinel=http.createServer((_request,response)=>{
  sentinelRequests++;
  response.setHeader('content-type','application/json');
  response.end(JSON.stringify({status:'ok',installMode:'npm',distribution:'cloudcli',version:'sentinel'}));
});
await new Promise((resolve,reject)=>{sentinel.once('error',reject);sentinel.listen(3001,'127.0.0.1',resolve);});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  appProcess=spawn(executable,['--disable-gpu'],{windowsHide:true,stdio:'ignore',env:{
    ...process.env,
    WORKBENCH_USER_DATA_DIR:profileDirectory,
    CLOUDCLI_LOCAL_SERVER_URL:'http://127.0.0.1:3001',
    CLOUDCLI_DESKTOP_LOCAL_SERVER_URL:'http://127.0.0.1:3001',
    ELECTRON_LOCAL_SERVER_URL:'http://127.0.0.1:3001',
    SERVER_PORT:'3001',PORT:'3001',DATABASE_PATH:sentinelDatabase,
    CLOUDCLI_HOME:path.join(profileDirectory,'wrong-home'),
    ELECTRON_NODE_PATH:'not-a-real-node',ELECTRON_SERVER_ENTRY:'not-a-real-server',
  }});
  let launchError;
  appProcess.once('error',error=>{launchError=error;});
  let marker,health;
  for (let attempt=0;attempt<90;attempt++) {
    if (launchError) throw launchError;
    try {
      marker=JSON.parse(await fs.readFile(path.join(profileDirectory,'server','local-server.json'),'utf8'));
      health=await fetch(`http://127.0.0.1:${marker.port}/health`).then(response=>response.json());
      if (health.distribution==='workbench') break;
    } catch {}
    await wait(1000);
  }
  assert.equal(health?.distribution,'workbench','installed app must start its bundled backend');
  assert.notEqual(marker.port,3001);
  ownedServerPid=marker.pid;
  const identity=JSON.parse(await fs.readFile(path.join(profileDirectory,'workbench-instance.json'),'utf8'));
  assert.equal(health.instanceId,identity.id);
  const product=JSON.parse(await fs.readFile(path.join(installDirectory,'resources','app','workbench-profile.json'),'utf8'));
  assert.equal(health.workbenchVersion,product.version);
  const bundledClaude=path.join(installDirectory,'resources','app','node_modules','@anthropic-ai','claude-agent-sdk-win32-x64','claude.exe');
  const claudeVersion=execFileSync(bundledClaude,['--version'],{encoding:'utf8',timeout:15000,windowsHide:true,
    env:{...process.env,CLAUDE_CONFIG_DIR:path.join(profileDirectory,'providers','claude')}}).trim();
  assert.ok(claudeVersion.length>0,'bundled provider executable must actually run');
  assert.equal(await fs.readFile(sentinelDatabase,'utf8'),sentinelContents);
  assert.equal(sentinelRequests,0,'must not even discover the unrelated server');
  const base=`http://127.0.0.1:${marker.port}`;
  const html=await fetch(base).then(response=>response.text());
  const asset=html.match(/\/assets\/index-[^"]+\.js/)?.[0];
  assert.ok(asset,'installed frontend index must reference a built bundle');
  assert.equal((await fetch(base+asset)).status,200);
  const key=(await fs.readFile(path.join(profileDirectory,'server','local-identity.key'),'utf8')).trim();
  const ticketResponse=await fetch(base+'/api/auth/local-ticket',{method:'POST',headers:{'X-Claudex-Local-Key':key}});
  assert.equal(ticketResponse.status,200);
  const ticket=await ticketResponse.json();
  const exchange=await fetch(base+'/api/auth/local-exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(ticket)});
  assert.equal(exchange.status,200);
  const account=await exchange.json();
  assert.ok(account.token);
  const authorized=await fetch(base+'/api/monitors',{headers:{Authorization:`Bearer ${account.token}`}});
  assert.equal(authorized.status,200,'business API must accept the isolated local account');
  const forbidden=await fetch(base+'/api/message-queue?sessionId=none');
  assert.equal(forbidden.status,401);
  const record={
    passed:true,distribution:health.distribution,workbenchVersion:health.workbenchVersion,portIsolated:marker.port!==3001,
    identityMatched:true,existingDatabaseUnchanged:true,unrelatedServerRequests:sentinelRequests,
    authenticatedApi:authorized.status,unauthenticatedQueue:forbidden.status,frontendAsset:asset,claudeVersion,
    localPasswordless:true,
  };
  await fs.mkdir(path.dirname(reportPath),{recursive:true});
  await fs.writeFile(reportPath,JSON.stringify(record,null,2));
  console.log(JSON.stringify(record));
} finally {
  // Only processes launched by this acceptance run, verified through its owned profile, are stopped.
  if (appProcess?.pid) {try {appProcess.kill();} catch {}}
  if (ownedServerPid) {try {process.kill(ownedServerPid);} catch {}}
  await new Promise(resolve=>sentinel.close(resolve));
}
