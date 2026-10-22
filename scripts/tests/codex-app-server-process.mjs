import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import readline from 'node:readline';
const require=createRequire(import.meta.url);
const launcher=require.resolve('@openai/codex/bin/codex.js');
const nativeLauncherPatched=/spawn\(binaryPath, process\.argv\.slice\(2\),\s*\{\s*windowsHide:\s*true/.test(await readFile(launcher,'utf8'));
assert.equal(nativeLauncherPatched,true);
const child=spawn(process.execPath,[launcher,'app-server'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
const lines=readline.createInterface({input:child.stdout});let initialized=false;
const result=await new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(Error('app-server handshake timeout')),15000);
 child.once('error',reject);child.stderr.resume();
 lines.on('line',line=>{
  let message;try{message=JSON.parse(line);}catch{return;}
  if(message.error){clearTimeout(timer);reject(Error('app-server rejected probe'));return;}
  if(message.id===1){initialized=true;child.stdin.write(JSON.stringify({method:'initialized'})+'\n');child.stdin.write(JSON.stringify({id:2,method:'model/list',params:{}})+'\n');}
  if(message.id===2){clearTimeout(timer);resolve({initialized,modelCount:message.result?.data?.length??0,launcherHidden:true,nativeLauncherPatched});}
 });
 child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'cloudcli_probe',title:'CloudCLI startup check',version:'0.2.0'},capabilities:{}}})+'\n');
});
child.stdin.end();
await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve();},3000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
lines.close();await writeFile(process.argv[2]+'/codex-app-server-result.json',JSON.stringify(result,null,2));
