// Real SDK differential: isolate product model discovery and product adapter.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const repository=path.dirname(fileURLToPath(new URL('../../package.json',import.meta.url)));
const build=process.env.PROVIDER_SURVIVAL_BUILD||path.join(repository,'dist-server');
const url=name=>pathToFileURL(path.join(build,name)).href;
const require=createRequire(path.join(repository,'package.json'));
const {DurableProvider}=await import(url('server/modules/providers/services/provider-supervisor.service.js'));
const root=path.join(process.env.PROVIDER_SURVIVAL_RESULTS||path.dirname(repository),'evidence','runtime-boundary-'+Date.now());
const cwd=path.join(root,'project'),home=path.join(root,'claude-home');fs.mkdirSync(cwd,{recursive:true});fs.mkdirSync(home);
for(const name of ['settings.json','.credentials.json'])fs.copyFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,name),path.join(home,name));
const executable=path.join(process.env.USERPROFILE,'.claude-cc','boxed','claude.exe');
const sdk=pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href;
const results=[];
for(const mode of (process.env.SURVIVAL_BOUNDARY_MODES||'discovery-sdk,adapter').split(',')){
 const script=path.join(root,mode+'.mjs');
 fs.writeFileSync(script,`import fs from 'node:fs';import {spawn} from 'node:child_process';import {query} from ${JSON.stringify(sdk)};process.on('exit',code=>console.log('JS_EXIT',code));const cwd=${JSON.stringify(cwd)},executable=${JSON.stringify(executable)};const spawnClaudeCodeProcess=opts=>{fs.appendFileSync(${JSON.stringify(path.join(root,mode+'-launch.ndjson'))},JSON.stringify({args:opts.args,env:opts.env,cwd:opts.cwd})+'\\n');const p=spawn(opts.command,opts.args,{cwd:opts.cwd,env:opts.env,signal:opts.signal,windowsHide:true,detached:false,stdio:['pipe','pipe','pipe']});console.log('NATIVE',p.pid);p.on('close',(code,signal)=>console.log('NATIVE_CLOSE',code,signal));return p;};
 ${mode==='discovery-sdk'?`const {loadSupervisedClaudeModels}=await import(${JSON.stringify(url('server/modules/providers/services/claude-supervised-spawn.service.js'))});console.log('DISCOVERY',(await loadSupervisedClaudeModels(executable,cwd)).length);const abortController=new AbortController();async function* held(){yield {type:'user',message:{role:'user',content:'Reply exactly RUNTIME_BOUNDARY_OK. Do not use tools.'}};await new Promise(r=>abortController.signal.addEventListener('abort',r,{once:true}));}const q=query({prompt:held(),options:{cwd,pathToClaudeCodeExecutable:executable,env:{...process.env},model:'sonnet',permissionMode:'bypassPermissions',persistSession:false,abortController,spawnClaudeCodeProcess}});for await(const row of q){console.log(JSON.stringify(row));if(row.type==='result'){q.close();abortController.abort();break;}}`:
 mode==='runtime-full'?`const {executeSupervisedTurn}=await import(${JSON.stringify(url('server/modules/providers/services/provider-turn-worker.js'))});await executeSupervisedTurn({provider:'claude',command:'Reply exactly RUNTIME_BOUNDARY_OK. Do not use tools.',userId:null,options:{cwd,model:'sonnet',permissionMode:'bypassPermissions'}},(kind,data)=>console.log(JSON.stringify({kind,data})),()=>{});`:
 `const {initializeDatabase,closeConnection}=await import(${JSON.stringify(url('server/modules/database/index.js'))});await initializeDatabase();const {providerRegistry}=await import(${JSON.stringify(url('server/modules/providers/provider.registry.js'))});const {queryClaudeSDK}=await import(${JSON.stringify(url('server/modules/providers/list/claude/claude-runtime.provider.js'))});await queryClaudeSDK('Reply exactly RUNTIME_BOUNDARY_OK. Do not use tools.',{cwd,sessionId:'runtime-boundary',model:'sonnet',permissionMode:'bypassPermissions'},{send:d=>console.log(JSON.stringify(d))},{resolveProviderSessionId:()=>null,resolveResumeModel:async(s,m)=>m,getProviderModels:async()=>({}),normalizeMessage:(r,s)=>providerRegistry.resolveProvider('claude').sessions.normalizeMessage(r,s),isProviderInstalled:async()=>true,createQuery:input=>{console.log('OPTION_KEYS',Object.keys(input.options));return query({...input,options:{...input.options,spawnClaudeCodeProcess}});}});closeConnection();`}`);
 const client=await DurableProvider.start(root,{command:process.execPath,args:[script],cwd},{...process.env,CLAUDE_CLI_PATH:executable,CLAUDE_CONFIG_DIR:home,CLOUDCLI_HOME:path.join(root,'home'),DATABASE_PATH:path.join(root,'test.db'),NEXAGENT_PROVIDER_TRACE:'1'});
 await client.control({type:'end'});let output='',exit,error;
 try{for await(const {event}of client.events()){if(['stdout','stderr'].includes(event.kind))output+=Buffer.from(event.data,'base64').toString('utf8');if(event.kind==='exit')exit=event.data;}}catch(e){error=e.message;}
 fs.writeFileSync(path.join(root,mode+'-output.log'),output);const row={mode,directory:client.directory,exit,error,passed:exit?.code===0&&output.includes('RUNTIME_BOUNDARY_OK')};results.push(row);fs.writeFileSync(path.join(root,'results.json'),JSON.stringify({root,results},null,2));console.log(JSON.stringify(row));
}
console.log(root);
