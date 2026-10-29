import assert from 'node:assert/strict';
import test from 'node:test';
import { parseScriptLine, runMonitorScript } from '../monitor-script.service.js';
import type { MonitorRecord } from '@/shared/types.js';

test('script lines distinguish progress, events, plain text and invalid JSON',()=>{
 const now=new Date();
 assert.deepEqual(parseScriptLine('{"type":"progress","progress":42}',now),{event:null,progress:42});
 assert.equal(parseScriptLine('{"type":"dead","key":"pid","msg":"gone"}',now).event?.signature,'script:pid');
 for(const line of ['hello','[]','null','42'])assert.equal(parseScriptLine(line,now).event?.type,'info');
});

test('PowerShell stdout preserves Chinese and caps each line',async()=>{
 const result=await runMonitorScript({id:'unicode-test',user_id:1} as MonitorRecord,{script:"Write-Output '中文事件'; Write-Output ('x' * 6000)"});
 assert.equal(result.error,null);assert.equal(result.lines[0],'中文事件');assert.equal(Buffer.byteLength(result.lines[1]),4096);
});

test('PowerShell module progress never corrupts UTF8 and UTF16 stderr diagnostics',async()=>{
 for(const script of [
  "New-Object PSObject | Out-Null; Write-Progress -Activity '准备模块'; [Console]::Error.WriteLine('中文诊断 UTF8'); exit 2",
  "$b=[Text.Encoding]::Unicode.GetBytes(([char]0xfeff)+'中文诊断 UTF16'); [Console]::OpenStandardError().Write($b,0,$b.Length); exit 2",
  "Write-Error '中文诊断 PowerShell'; exit 2",
 ]){
  const result=await runMonitorScript({id:'stderr-encoding-test',user_id:1} as MonitorRecord,{script});
  assert.match(result.error||'',/中文诊断/);assert.doesNotMatch(result.error||'',/[\u0000\uFFFD]|CLIXML|<Objs/);
 }
});
