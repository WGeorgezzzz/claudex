// Local SDK transport boundary control: no product runtime, shared code or model discovery.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const repository=path.dirname(fileURLToPath(new URL('../../package.json',import.meta.url))),require=createRequire(path.join(repository,'package.json'));
const build=process.env.PROVIDER_SURVIVAL_BUILD||path.join(repository,'dist-server');
const {DurableProvider}=await import(pathToFileURL(path.join(build,'server/modules/providers/services/provider-supervisor.service.js')));
const root=path.join(process.env.PROVIDER_SURVIVAL_RESULTS||path.dirname(repository),'evidence','sdk-boundary-'+Date.now());
const cwd=path.join(root,'project'),home=path.join(root,'claude-home');fs.mkdirSync(cwd,{recursive:true});fs.mkdirSync(home);
for(const n of ['settings.json','.credentials.json'])fs.copyFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,n),path.join(home,n));
const executable=path.join(process.env.USERPROFILE,'.claude-cc','boxed','claude.exe');
const script=path.join(root,'sdk.mjs');
const sdk=pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href;
fs.writeFileSync(script,`import fs from 'node:fs';import {query} from ${JSON.stringify(sdk)};import {spawn} from 'node:child_process';process.on('exit',code=>fs.writeFileSync(${JSON.stringify(path.join(root,'sdk-exit.json'))},JSON.stringify({code})));const controlOnly=process.env.SURVIVAL_CONTROL_ONLY==='1';const abortController=new AbortController();async function* held(){if(!controlOnly)yield {type:'user',message:{role:'user',content:'Reply exactly SDK_BOUNDARY_OK. Do not call tools.'}};await new Promise(resolve=>abortController.signal.addEventListener('abort',resolve,{once:true}));}const q=query({prompt:held(),options:{pathToClaudeCodeExecutable:${JSON.stringify(executable)},cwd:${JSON.stringify(cwd)},env:{...process.env},permissionMode:'bypassPermissions',model:'sonnet',persistSession:false,abortController,spawnClaudeCodeProcess(opts){const p=spawn(opts.command,opts.args,{cwd:opts.cwd,env:opts.env,signal:opts.signal,windowsHide:true,detached:false,stdio:['pipe','pipe','pipe']});fs.appendFileSync(${JSON.stringify(path.join(root,'sdk-spawn.ndjson'))},JSON.stringify({pid:process.pid,child:p.pid,args:opts.args})+'\\n');p.on('exit',(code,signal)=>console.log('CHILD_EXIT',code,signal));return p;}}});if(controlOnly){console.log('SUPPORTED_MODELS',(await q.supportedModels()).length);q.close();abortController.abort();}else {for await(const row of q){console.log(JSON.stringify(row));if(row.type==='result'){q.close();abortController.abort();break;}}}`);
const results=[];
for(const controlOnly of [true,false]){
 const c=await DurableProvider.start(root,{command:process.execPath,args:[script],cwd},{...process.env,CLAUDE_CLI_PATH:executable,CLAUDE_CONFIG_DIR:home,NEXAGENT_PROVIDER_TRACE:'1',SURVIVAL_CONTROL_ONLY:controlOnly?'1':'0'});
 await c.control({type:'end'});let output='',exit,error;
 try{for await(const {event}of c.events()){if(event.kind==='stdout'||event.kind==='stderr')output+=Buffer.from(event.data,'base64').toString('utf8');if(event.kind==='exit')exit=event.data;}}catch(e){error=e.message;}
 fs.writeFileSync(path.join(root,controlOnly?'control-output.log':'model-output.log'),output);
 results.push({controlOnly,directory:c.directory,exit,error,passed:output.includes(controlOnly?'SUPPORTED_MODELS':'SDK_BOUNDARY_OK')});
 fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({root,results},null,2));console.log(JSON.stringify(results.at(-1)));
}
console.log(root);
