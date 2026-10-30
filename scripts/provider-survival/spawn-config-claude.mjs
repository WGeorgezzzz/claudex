// Same executable/cwd/auth/broker, one changed spawn flag per historical control.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const repository=path.dirname(fileURLToPath(new URL('../../package.json',import.meta.url)));
const build=path.resolve(process.env.PROVIDER_SURVIVAL_BUILD||path.join(repository,'dist-server'));
const {DurableProvider}=await import(pathToFileURL(path.join(build,'server/modules/providers/services/provider-supervisor.service.js')));
const root=path.join(process.env.PROVIDER_SURVIVAL_RESULTS||path.dirname(repository),'evidence','spawn-config-'+Date.now());
fs.mkdirSync(root,{recursive:true});
const cwd=path.join(root,'project'),home=path.join(root,'claude-home');fs.mkdirSync(cwd);fs.mkdirSync(home);
for(const n of ['settings.json','.credentials.json'])fs.copyFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,n),path.join(home,n));
const executable=path.join(process.env.USERPROFILE,'.claude-cc','boxed','claude.exe');
const preload=path.join(root,'spawn-config.mjs');
fs.writeFileSync(preload,`import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=cp.spawn;cp.spawn=function(command,args,options){if(command.toLowerCase()===${JSON.stringify(executable.toLowerCase())}){options={...options,detached:process.env.SURVIVAL_CLAUDE_DETACHED==='1'};fs.appendFileSync(${JSON.stringify(path.join(root,'effective-spawn.ndjson'))},JSON.stringify({at:new Date().toISOString(),pid:process.pid,command,detached:options.detached,cwd:options.cwd})+'\\n');}return original.call(this,command,args,options)};syncBuiltinESMExports();`);
const env={...process.env,CLAUDE_CLI_PATH:executable,CLAUDE_CONFIG_DIR:home,CLOUDCLI_HOME:path.join(root,'home'),DATABASE_PATH:path.join(root,'test.db'),NEXAGENT_PROVIDER_TRACE:'1',NODE_OPTIONS:'--import='+pathToFileURL(preload).href};
const prompt='Reply exactly SPAWN_CONFIG_OK. Do not call any tools.';
const results=[];
for(const [mode,detached] of [['raw',true],['runtime',false]]){
 const spec=mode==='raw'?{command:executable,args:['--print','--output-format','stream-json','--verbose','--model','sonnet','--permission-mode','bypassPermissions','--no-session-persistence',prompt],cwd}:{mode,provider:'claude',command:prompt,userId:null,options:{sessionId:'spawn-config',cwd,model:'sonnet',permissionMode:'bypassPermissions'}};
 const client=await DurableProvider.start(root,spec,{...env,SURVIVAL_CLAUDE_DETACHED:detached?'1':'0'});
 if(mode==='raw')await client.control({type:'end'});
 let text='',exit,error;
 try{for await(const {event}of client.events()){if(event.kind==='message')text+=JSON.stringify(event.data);if(event.kind==='stdout')text+=Buffer.from(event.data,'base64').toString('utf8');if(event.kind==='exit')exit=event.data;}}catch(e){error=e.message;}
 results.push({mode,detached,directory:client.directory,exit,error,passed:text.includes('SPAWN_CONFIG_OK')});
 fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({root,results},null,2));console.log(JSON.stringify(results.at(-1)));
}
console.log(root);assert.ok(results.every(row=>row.passed));
