import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { runCodexAppServerTurn, submitCodexLiveInput } from '@/modules/providers/list/codex/codex-app-server-turn.service.js';
import type { ProviderLiveInputResult } from '@/shared/types.js';

type Request = { id?: number; method?: string; params?: Record<string, any>; result?: unknown };

/** A scripted `codex app-server`: answers handshake/thread/turn requests and lets the test emit notifications. */
function fakeServer(onRequest: (request: Request, reply: (result: unknown, error?: string) => void, notify: (method: string, params: unknown) => void) => void) {
  const stdout = new PassThrough();
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  const requests: Request[] = [];
  const notify = (method: string, params: unknown) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  let buffer = '';
  const stdin = new Writable({
    write(chunk, _encoding, done) {
      buffer += String(chunk);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, index)) as Request;
        buffer = buffer.slice(index + 1);
        requests.push(request);
        if (request.method) {
          onRequest(request, (result, error) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(error ? { error: { message: error } } : { result }) })}\n`), notify);
        }
      }
      done();
    },
  });
  Object.assign(child, { stdin, stdout, stderr: new PassThrough(), kill: () => { setImmediate(() => child.emit('exit', 0, null)); return true; } });
  return { child, requests, notify };
}

const THREAD = 'thread-1';
const TURN = 'turn-1';

test('monitor context uses developer instructions while native user input stays exact',async()=>{
  for(const context of ['NEW_REPORT',undefined]){
    const server=fakeServer((request,reply,notify)=>{
      if(request.method==='thread/start'){assert.equal(request.params?.developerInstructions,context??null);return reply({thread:{id:THREAD}});}
      reply({});
      if(request.method==='turn/start'){
        assert.deepEqual(request.params?.input,[{type:'text',text:'用户原话',text_elements:[]}]);
        assert.equal(request.params?.collaborationMode.settings.developer_instructions,context??null);
        notify('turn/completed',{threadId:THREAD,turn:{id:TURN,status:'completed'}});
      }
    });
    for await(const _event of runCodexAppServerTurn({env:{},cwd:process.cwd(),model:'test-model',sandbox:'workspace-write',approvalPolicy:'never',input:'用户原话',monitorReportContext:context,signal:new AbortController().signal,sessionKeys:()=>['context-test'],spawnServer:()=>server.child})){}
  }
});

test('monitor rounds disable discovered skills, memory and unrelated MCP only for their thread',async()=>{
  let config:Record<string,any>|undefined;
  const server=fakeServer((request,reply,notify)=>{
    if(request.method==='config/read')return reply({config:{mcp_servers:{unrelated:{command:'unused'}}}});
    if(request.method==='skills/list')return reply({data:[{skills:[{path:'C:/test/skill/SKILL.md'}]}]});
    if(request.method==='thread/start'){config=request.params?.config;return reply({thread:{id:THREAD}});}
    reply({});
    if(request.method==='turn/start')notify('turn/completed',{threadId:THREAD,turn:{id:TURN,status:'completed'}});
  });
  for await(const _event of runCodexAppServerTurn({env:{},cwd:process.cwd(),sandbox:'workspace-write',approvalPolicy:'never',input:'check',signal:new AbortController().signal,monitorSlim:true,sessionKeys:()=>['monitor-test'],spawnServer:()=>server.child})){}
  assert.equal(config?.['features.memories'],false);
  assert.equal(config?.['mcp_servers.unrelated.enabled'],false);
  assert.deepEqual(config?.['skills.config'],[{path:'C:/test/skill/SKILL.md',enabled:false}]);
});

test('a running app-server turn accepts steered input and settles it with the turn', async () => {
  let steerParams: Record<string, any> | undefined;
  const server = fakeServer((request, reply, notify) => {
    switch (request.method) {
      case 'initialize': reply({}); break;
      case 'thread/start': reply({ thread: { id: THREAD } }); break;
      case 'turn/start':
        reply({ turn: { id: TURN, status: 'inProgress' } });
        notify('turn/started', { threadId: THREAD, turn: { id: TURN } });
        notify('item/completed', { threadId: THREAD, turnId: TURN, item: { type: 'commandExecution', id: 'c1', command: 'sleep 1', aggregatedOutput: '1\n', exitCode: 0, status: 'completed' } });
        break;
      case 'turn/steer':
        steerParams = request.params;
        reply({ turnId: TURN });
        notify('item/completed', { threadId: THREAD, turnId: TURN, item: { type: 'userMessage', id: 'u2', clientId: request.params?.clientUserMessageId, content: [] } });
        notify('item/completed', { threadId: THREAD, turnId: TURN, item: { type: 'agentMessage', id: 'a1', text: '插入成功' } });
        notify('thread/tokenUsage/updated', { threadId: THREAD, turnId: TURN, tokenUsage: { total: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, totalTokens: 13 }, modelContextWindow: 1000 } });
        notify('turn/completed', { threadId: THREAD, turn: { id: TURN, status: 'completed' } });
        break;
      default: reply({});
    }
  });

  const events: Record<string, any>[] = [];
  let settled: ProviderLiveInputResult | undefined;
  for await (const event of runCodexAppServerTurn({
    env: {}, cwd: process.cwd(), sandbox: 'workspace-write', approvalPolicy: 'on-request',
    input: 'count slowly', signal: new AbortController().signal,
    sessionKeys: () => ['app-session'], spawnServer: () => server.child,
  })) {
    events.push(event);
    if (event.type === 'item.completed' && event.item.type === 'command_execution') {
      submitCodexLiveInput('app-session', 'live-1', '停止计数', (result) => { settled = result; });
    }
  }

  assert.deepEqual(events.map((event) => event.type), ['thread.started', 'turn.started', 'item.completed', 'item.completed', 'turn.completed']);
  assert.equal(events[0].thread_id, THREAD);
  assert.equal(events[3].item.type, 'agent_message');
  assert.equal(events[3].item.text, '插入成功');
  assert.equal(events[4].usage.input_tokens, 10);
  assert.equal(steerParams?.expectedTurnId, TURN);
  assert.equal(steerParams?.clientUserMessageId, 'live-1');
  assert.deepEqual(steerParams?.input, [{ type: 'text', text: '停止计数', text_elements: [] }]);
  assert.deepEqual(settled, { status: 'succeeded', error: null });
  // The channel closes with the turn.
  assert.throws(() => submitCodexLiveInput('app-session', 'late', 'x', () => {}), /no longer accepting input/);
});

test('a rejected steer settles as failed and a resumed thread uses thread/resume', async () => {
  const server = fakeServer((request, reply, notify) => {
    switch (request.method) {
      case 'thread/resume': reply({ thread: { id: THREAD } }); break;
      case 'turn/start':
        reply({ turn: { id: TURN } });
        notify('turn/started', { threadId: THREAD, turn: { id: TURN } });
        break;
      case 'turn/steer':
        reply(null, 'expected turn mismatch');
        setImmediate(() => notify('turn/completed', { threadId: THREAD, turn: { id: TURN, status: 'failed', error: { message: 'boom' } } }));
        break;
      default: reply({});
    }
  });
  const events: Record<string, any>[] = [];
  let settled: ProviderLiveInputResult | undefined;
  for await (const event of runCodexAppServerTurn({
    env: {}, resumeThreadId: THREAD, cwd: process.cwd(), sandbox: 'workspace-write', approvalPolicy: 'never',
    input: [{ type: 'text', text: 'hi' }], signal: new AbortController().signal,
    sessionKeys: () => ['app-2'], spawnServer: () => server.child,
  })) {
    events.push(event);
    if (event.type === 'turn.started') submitCodexLiveInput('app-2', 'live-2', 'more', (result) => { settled = result; });
  }
  assert.ok(server.requests.some((request) => request.method === 'thread/resume' && request.params?.threadId === THREAD));
  assert.equal(settled?.status, 'failed');
  assert.match(settled?.error ?? '', /did not accept/);
  assert.equal(events.at(-1)?.type, 'turn.failed');
});
