// Isolated real-process test. Build first; credentials are copied locally, never printed.
// PROVIDER_SURVIVAL_BUILD points to dist-server; PROVIDER_SURVIVAL_RESULTS selects private output storage.
import {fileURLToPath,pathToFileURL} from 'node:url';import os from 'node:os';
const repository=path.dirname(fileURLToPath(new URL('../../package.json',import.meta.url)));
const build=path.resolve(process.env.PROVIDER_SURVIVAL_BUILD||path.join(repository,'dist-server'));
const moduleURL=relative=>pathToFileURL(path.join(build,relative)).href;
const results=process.env.PROVIDER_SURVIVAL_RESULTS||fs.mkdtempSync(path.join(os.tmpdir(),'nexagent-survival-'));fs.mkdirSync(results,{recursive:true});process.chdir(results);
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const {DurableProvider}=await import(moduleURL('server/modules/providers/services/provider-supervisor.service.js'));
const root=path.resolve('evidence/matched-claude-'+Date.now()),cwd=path.join(root,'project'),home=path.join(root,'claude-home');fs.mkdirSync(cwd,{recursive:true});fs.mkdirSync(home);
for(const n of ['settings.json','.credentials.json'])fs.copyFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,n),path.join(home,n));
const executable=path.join(process.env.USERPROFILE,'.claude-cc','boxed','claude.exe'),sha=crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
const env={...process.env,CLAUDE_CLI_PATH:executable,CLAUDE_CONFIG_DIR:home,CLOUDCLI_HOME:path.join(root,'home'),DATABASE_PATH:path.join(root,'test.db'),NEXAGENT_PROVIDER_TRACE:'1'};
const prompt='Reply exactly MATCHED_TRACE_OK. Do not call any tools.';
const metadata={root,executable,sha256:sha,cwd,claudeConfigDir:home,sourceCredentialCopyEqual:fs.readFileSync(path.join(home,'.credentials.json')).equals(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR,'.credentials.json')))};fs.writeFileSync(path.join(root,'control-metadata.json'),JSON.stringify(metadata,null,2));console.log(JSON.stringify(metadata,null,2));
const raw=await DurableProvider.start(root,{command:executable,args:['--print','--output-format','stream-json','--verbose','--model','sonnet','--permission-mode','bypassPermissions','--no-session-persistence',prompt],cwd},env);await raw.control({type:'end'});let rawText='',rawExit;
for await(const{event}of raw.events()){if(event.kind==='stdout')rawText+=Buffer.from(event.data,'base64').toString('utf8');if(event.kind==='exit')rawExit=event.data;}
fs.writeFileSync(path.join(root,'raw-result.json'),JSON.stringify({directory:raw.directory,exit:rawExit,passed:rawText.includes('MATCHED_TRACE_OK')}));
const sdk=await DurableProvider.start(root,{mode:'runtime',provider:'claude',command:prompt,userId:null,options:{sessionId:'matched-test',cwd,model:'sonnet',permissionMode:'bypassPermissions'}},env);let sdkText='',sdkExit,error;
try{for await(const{event}of sdk.events()){if(event.kind==='message')sdkText+=JSON.stringify(event.data);if(event.kind==='exit')sdkExit=event.data;}}catch(e){error=e.message;}
const result={metadata,raw:{directory:raw.directory,exit:rawExit,passed:rawText.includes('MATCHED_TRACE_OK')},sdk:{directory:sdk.directory,exit:sdkExit,passed:sdkText.includes('MATCHED_TRACE_OK'),error}};fs.writeFileSync(path.join(root,'assertions.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));


if(!result.raw.passed||!result.sdk.passed)process.exitCode=1;
