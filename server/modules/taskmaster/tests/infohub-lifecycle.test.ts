import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createInfohubLifecycle,launchInfohubProcess } from '../taskmaster-infohub-lifecycle.service.js';

test('no autostart; explicit requests are single flight; idle exits only owned processes',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
  let online=false,launches=0,stops=0,collections=0,syncs=0;
  let release!:()=>void;const collection=new Promise<void>(resolve=>{release=resolve;});
  const lifecycle=createInfohubLifecycle({probe:async()=>{if(!online)throw Error('offline');},launch:async()=>{launches++;online=true;return {pid:1234,stop:async()=>{stops++;online=false;}};},collect:async()=>{collections++;await collection;},reconcile:async()=>{syncs++;return {online:true,error:null};}});
  assert.equal(launches,0);assert.equal(lifecycle.snapshot().phase,'stopped');
  lifecycle.start(1);lifecycle.start(1);
  for(let i=0;i<8;i++)await Promise.resolve();
  assert.equal(launches,1);assert.equal(collections,1);
  t.mock.timers.tick(11*60000);assert.equal(stops,0);
  release();await lifecycle.settled();assert.equal(syncs,1);assert.equal(lifecycle.snapshot().phase,'idle');
  t.mock.timers.tick(9*60000);assert.equal(stops,0);
  t.mock.timers.tick(60000);await Promise.resolve();await Promise.resolve();assert.equal(stops,1);assert.equal(lifecycle.snapshot().phase,'stopped');
});

test('an already running external hub is reused and never stopped; failure does not restart it',async()=>{
  let launches=0,stops=0;
  const lifecycle=createInfohubLifecycle({probe:async()=>({ok:true}),launch:async()=>{launches++;return {pid:123,stop:async()=>{stops++;}};},collect:async()=>{throw Error('need_user_authorization');},reconcile:async()=>({online:true,error:null})});
  lifecycle.start(1);await lifecycle.settled();assert.equal(launches,0);assert.equal(lifecycle.snapshot().owned,false);assert.match(lifecycle.snapshot().error!,/authorization/);
  await lifecycle.stop();assert.equal(stops,0);assert.equal(launches,0);
});

test('idle shutdown defers while a background task reconciliation is active',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
  let online=false,busy=false,stops=0;
  const lifecycle=createInfohubLifecycle({isBusy:()=>busy,probe:async()=>{if(!online)throw Error('offline');},launch:async()=>{online=true;return {pid:123,stop:async()=>{stops++;}};},collect:async()=>({}),reconcile:async()=>({online:true,error:null})});
  lifecycle.configure(1);lifecycle.start(1);await lifecycle.settled();busy=true;
  t.mock.timers.tick(60000);assert.equal(stops,0);busy=false;
  t.mock.timers.tick(1000);await Promise.resolve();assert.equal(stops,1);
});

test('authorization and launcher failures never create duplicate processes or claim a running hub',async()=>{
  let launches=0;
  const unauthorized=createInfohubLifecycle({probe:async()=>{throw Object.assign(Error('unauthorized'),{statusCode:401});},launch:async()=>{launches++;throw Error('must not launch');},collect:async()=>({}),reconcile:async()=>({online:true,error:null})});
  unauthorized.start(1);await unauthorized.settled();assert.equal(launches,0);assert.equal(unauthorized.snapshot().running,true);assert.equal(unauthorized.snapshot().owned,false);
  const missing=createInfohubLifecycle({probe:async()=>{throw Error('offline');},launch:async()=>{throw Error('python unavailable');},collect:async()=>({}),reconcile:async()=>({online:true,error:null})});
  missing.start(1);await missing.settled();assert.equal(missing.snapshot().running,false);assert.equal(missing.snapshot().owned,false);
});

test('real headless launcher executes a private script and stops only its own Python',async t=>{
  const python=process.env.INFOHUB_TEST_PYTHON||'D:/embodied/info-hub/.venv/Scripts/python.exe';
  try{await access(python);}catch{t.skip('Local Python unavailable');return;}
  const root=await mkdtemp(path.join(os.tmpdir(),'infohub-launch-fixture-'));await mkdir(path.join(root,'infohub'));
  await writeFile(path.join(root,'infohub','__init__.py'),'');
  const ready=path.join(root,'ready');
  await writeFile(path.join(root,'infohub','__main__.py'),`import os,time,pathlib\npathlib.Path(${JSON.stringify(ready.replaceAll('\\','/'))}).write_text(str(os.getpid()))\nwhile True: time.sleep(0.1)\n`);
  const previous={INFOHUB_ROOT:process.env.INFOHUB_ROOT,INFOHUB_PYTHON:process.env.INFOHUB_PYTHON};
  process.env.INFOHUB_ROOT=root;process.env.INFOHUB_PYTHON=python;
  let owned:Awaited<ReturnType<typeof launchInfohubProcess>>|undefined;
  try{owned=await launchInfohubProcess();for(let i=0;i<50;i++){try{await readFile(ready);break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
    assert.equal(Number(await readFile(ready,'utf8')),owned.pid);await owned.stop();owned=undefined;
  }finally{if(owned)await owned.stop();for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
