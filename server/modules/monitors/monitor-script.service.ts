import { spawn } from 'node:child_process';
import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import { killProcessTree } from '@/shared/process-tree.js';
import type { MonitorProbeEvent, MonitorRecord } from '@/shared/types.js';

/** Windows native commands (including WSL launch errors) may emit UTF-16LE. */
export function decodeScriptOutput(bytes: Buffer): string {
  const sample = bytes.subarray(0, 512);
  let oddZeros = 0;
  for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0) oddZeros++;
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (sample.length >= 8 && oddZeros > sample.length / 8);
  return bytes.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');
}

/** PowerShell serializes its error stream as CLIXML even with text stdout. */
export function decodeScriptDiagnostics(bytes: Buffer): string {
  const unescape=(text:string)=>text.replace(/_x([0-9a-f]{4})_/gi,(_,hex:string)=>String.fromCharCode(parseInt(hex,16)))
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
  return decodeScriptOutput(bytes).replace(/#< CLIXML\s*/g,'').replace(/<Objs\b[^>]*>[\s\S]*?(?:<\/Objs>|$)/g,xml=>
    [...xml.matchAll(/<S\b[^>]*\bS="Error"[^>]*>([\s\S]*?)<\/S>/g)].map(match=>unescape(match[1])).join('')).trim();
}

/** Probe service runs bounded polling scripts as the service identity, without elevation.
 * MONITOR_STATE_DIR is private to the owning user and monitor. Only stdout is event input.
 */
export async function runMonitorScript(row:MonitorRecord,item:Record<string,unknown>) {
  const directory=path.join(process.env.CLOUDCLI_HOME||path.join(os.homedir(),'.cloudcli'),'monitor-state',String(row.user_id),row.id);
  await mkdir(directory,{recursive:true});
  const script=String(item.script||'');
  const shell=item.shell==='bash'?'bash':process.platform==='win32'?'powershell.exe':'pwsh';
  const prefix=item.shell==='bash'?'ssh() { command ssh -o BatchMode=yes "$@"; };\n':"$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding\nfunction ssh { & ssh.exe -o BatchMode=yes @args }\n";
  const source=prefix+script;
  const args=item.shell==='bash'?['-c',source]:['-NoLogo','-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from(source,'utf16le').toString('base64')];
  const hash=createHash('sha256').update(script).digest('hex');
  await appendFile(path.join(directory,'executions.jsonl'),JSON.stringify({at:new Date().toISOString(),hash,shell})+'\n');
  return new Promise<{lines:string[];error:string|null}>(resolve=>{
    const child=spawn(shell,args,{windowsHide:true,env:{...process.env,MONITOR_STATE_DIR:directory},stdio:['ignore','pipe','pipe']});
    let output=Buffer.alloc(0),stderr=Buffer.alloc(0),failure:string|null=null;
    const stop=()=>{if(child.pid)void killProcessTree(child.pid);else child.kill();};
    const timer=setTimeout(()=>{failure='script timeout (60 seconds)';stop();},60000);
    child.stdout.on('data',(chunk:Buffer)=>{if(output.length+chunk.length<=256*1024)output=Buffer.concat([output,chunk]);else {failure='script output exceeds 256KB';stop();}});
    child.stderr.on('data',(chunk:Buffer)=>{stderr=Buffer.concat([stderr,chunk]).subarray(0,8192);});
    child.once('error',error=>{clearTimeout(timer);resolve({lines:[],error:error.message});});
    child.once('close',code=>{clearTimeout(timer);resolve({lines:decodeScriptOutput(output).split(/\r?\n/).filter(line=>line.trim()).map(line=>Buffer.from(line).subarray(0,4096).toString('utf8')),error:failure||(code?`script exit ${code}: ${decodeScriptDiagnostics(stderr).slice(0,1000)}`:null)});});
  });
}

/** Converts one stdout line for the probe service; progress deliberately has no model event. */
export function parseScriptLine(line:string,now:Date):{event:MonitorProbeEvent|null;progress?:unknown} {
  let value:Record<string,unknown>;try{value=JSON.parse(line);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();}catch{value={type:'info',msg:line};}
  if(value.type==='progress')return {event:null,progress:value.progress??value.msg??line};
  const type=['error','stall','done','dead','info'].includes(String(value.type))?String(value.type) as MonitorProbeEvent['type']:'info';
  return {event:{type,at:now.toISOString(),evidence:String(value.msg??line).slice(0,1000),signature:'script:'+String(value.key??createHash('sha256').update(line).digest('hex').slice(0,24)),delta:line}};
}
