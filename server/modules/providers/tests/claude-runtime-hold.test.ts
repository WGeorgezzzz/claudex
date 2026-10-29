import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { submitClaudeLiveInput } from '@/modules/providers/list/claude/claude-prompt-stream.service.js';
import {
  listClaudeSDKBackgroundWork,
  queryClaudeSDK,
  stopClaudeSDKTask,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * The runtime keeps the CLI's stdin open after a turn's `result` while the
 * turn's background work is outstanding, and lets go when that work has
 * reported. These drive `queryClaudeSDK` with a scripted SDK stream — the
 * seam is `context.createQuery` — and watch the held prompt stream: the CLI
 * exits when it ends, so "released" is the whole outcome.
 */

const SESSION_ID = 'app-hold-session';
const NATIVE_ID = 'native-hold-session';

type Scripted = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  released: () => boolean;
  stopped: string[];
  prompts: unknown[];
  modes: string[];
  context: () => Promise<unknown>;
};

/** A stand-in for the SDK query: yields what the test emits, and reads the held prompt to notice its release. */
function createScriptedQuery(): { createQuery: NonNullable<ProviderRuntimeContext['createQuery']>; script: Scripted } {
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  let released = false;
  const stopped: string[] = [];
  const prompts: unknown[] = [];
  const modes: string[] = [];

  const script: Scripted = {
    emit: (message) => {
      if (message.type === 'result' && message.user_message_uuid === undefined) {
        message.user_message_uuid = (prompts.at(-1) as {uuid?: string} | undefined)?.uuid;
      }
      queue.push(message); wake?.();
    },
    end: () => { queue.push(null); wake?.(); },
    released: () => released,
    stopped,
    prompts,
    modes,
    context: async () => ({}),
  };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options }) => {
    script.context = options.hooks!.UserPromptSubmit![0].hooks[0] as never;
    void (async () => {
      for await (const message of prompt) { prompts.push(message); }
      released = true;
    })();

    const iterator = (async function* () {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) {
          return;
        }
        yield next;
      }
    })();

    return Object.assign(iterator, {
      interrupt: async () => {},
      setPermissionMode: async (mode: string) => { modes.push(mode); },
      stopTask: async (taskId: string) => { stopped.push(taskId); },
    });
  };

  return { createQuery, script };
}

async function withRun(
  runTest: (context: { script: Scripted; sent: NormalizedMessage[]; done: Promise<unknown>; continueRun: (writer: unknown, options?: Record<string, unknown>) => Promise<unknown> }) => Promise<void>,
  initialOptions:Record<string,unknown> = {},
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-hold-'));
  const { createQuery, script } = createScriptedQuery();
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
  };

  const done = queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd, ...initialOptions }, writer as never, context);
  try {
    await waitFor(() => script.prompts.length === 1);
    await runTest({ script, sent, done, continueRun: (nextWriter, options = {}) => queryClaudeSDK('second prompt', { sessionId: SESSION_ID, cwd, ...options }, nextWriter as never, { ...context, createQuery: () => { throw new Error('must reuse the live query'); } }) });
    script.end();
    await done;
  } finally {
    script.end();
    await done;
    await rm(cwd, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 25); });

test('a fresh Claude prompt receives report context through a one-time hook and keeps the user text',async()=>{
  await withRun(async({script,done})=>{
    assert.equal((script.prompts[0] as any).message.content,'hello');
    assert.deepEqual(await script.context(),{hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'NEW_REPORT'}});
    assert.deepEqual(await script.context(),{});
    script.emit({type:'result',subtype:'success',session_id:NATIVE_ID,result:'done'});
    script.end();
    await done;
  },{cloudcliMonitorReportContext:'NEW_REPORT'});
});

test('a native error result cannot report a successful queue completion',async()=>{
  await withRun(async({script,sent,done})=>{
    script.emit({type:'result',subtype:'error_during_execution',is_error:true,errors:['No conversation found']});
    await done;
    assert.ok(sent.some(message=>message.kind==='error'));
    assert.equal(sent.find(message=>message.kind==='complete')?.success,false);
  });
});

// A fixed settle can be too short on a loaded machine; the supersede tests
// wait for the run to have actually processed its turn instead.
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await settle();
  }
  assert.ok(condition(), 'condition never became true');
}

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const ack = (id: string, text: string, toolUseResult: Record<string, unknown>) => ({
  type: 'user', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  tool_use_result: toolUseResult,
});
const taskStarted = (taskId: string, toolUseId: string, taskType: string) => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, description: `Task ${taskId}`, task_type: taskType,
});
const taskNotification = (taskId: string, toolUseId: string, status: string) => ({
  type: 'system', subtype: 'task_notification', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, status, summary: `Task ${taskId} ${status}`, output_file: '',
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'launched', duration_ms: 1, num_turns: 1 });

test('live additions reuse the current prompt stream and unrelated results cannot finish them',async()=>{
  await withRun(async({script,sent})=>{
    const original=(script.prompts[0] as {uuid:string}).uuid;
    script.emit({...toolUse('tool-live','Bash',{command:'working'}),user_message_uuid:original});
    await settle();
    const receipts:unknown[]=[];
    submitClaudeLiveInput(SESSION_ID,'11111111-1111-4111-8111-111111111111','additional requirement',receipt=>receipts.push(receipt));
    await waitFor(()=>script.prompts.length===2);
    script.emit({...result(),user_message_uuid:original});
    await settle();
    assert.equal(sent.filter(message=>message.kind==='complete').length,0);
    assert.equal(script.released(),false);
    assert.equal(receipts.length,0);
    script.emit({...result(),user_message_uuids:[original,'11111111-1111-4111-8111-111111111111']});
    await waitFor(()=>receipts.length===1);
    assert.deepEqual(receipts,[{status:'succeeded',error:null}]);
    assert.equal(sent.filter(message=>message.kind==='complete').length,1);
    assert.deepEqual(script.stopped,[]);
  });
});

test('closing before the added prompt is answered preserves an interrupted receipt',async()=>{
  await withRun(async({script,done})=>{
    const original=(script.prompts[0] as {uuid:string}).uuid;
    script.emit({...toolUse('tool-live','Bash',{}),user_message_uuid:original});
    await settle();
    const receipts:Array<{status:string}>=[];
    submitClaudeLiveInput(SESSION_ID,'22222222-2222-4222-8222-222222222222','keep this instruction',receipt=>receipts.push(receipt));
    script.end();await done;
    assert.equal(receipts[0]?.status,'interrupted');
    assert.throws(()=>submitClaudeLiveInput(SESSION_ID,'another','must not restart',()=>{}),/no longer accepting/);
  });
});

test('an immediate follow-up waits for ordinary process teardown and then resumes', async () => {
  const first=createScriptedQuery(), second=createScriptedQuery();
  const sent: NormalizedMessage[]=[];
  const sessions=new ClaudeSessionsProvider({getLiveRunStartTime:()=>null});
  let calls=0;
  const context: ProviderRuntimeContext={
    resolveProviderSessionId:()=>NATIVE_ID,
    resolveResumeModel:async()=>undefined,
    getProviderModels:async()=>CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage:(raw,id)=>sessions.normalizeMessage(raw,id),
    isProviderInstalled:async()=>true,
    createQuery:args=>(++calls===1?first:second).createQuery(args),
  };
  const writer={send:(message:NormalizedMessage)=>sent.push(message),userId:null};
  const options={sessionId:'ordinary-teardown-session',cwd:os.tmpdir()};
  const initial=queryClaudeSDK('first',options,writer as never,context);
  let followup:Promise<unknown>|undefined;
  try {
    await waitFor(()=>first.script.prompts.length===1);
    first.script.emit(init());first.script.emit(result());
    await waitFor(()=>first.script.released());
    followup=queryClaudeSDK('second',options,writer as never,context);
    await settle();
    assert.equal(calls,1,'must wait for the original SDK iterator to end');
    first.script.end();
    await waitFor(()=>second.script.prompts.length===1);
    second.script.emit(init());second.script.emit(result());second.script.end();
    await followup;
    assert.equal(sent.filter(message=>message.kind==='complete').length,2);
    assert.equal(sent.some(message=>message.kind==='error'),false);
  } finally {
    first.script.end();second.script.end();
    await initial;await followup;
  }
});

test('stopping the last outstanding task releases the held process', async () => {
  await withRun(async ({ script, sent, done }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await settle();

    // The turn is over for the client, the process is held for the workflow.
    assert.ok(sent.some((message) => message.kind === 'complete'));
    assert.deepEqual(listClaudeSDKBackgroundWork().map((entry) => [entry.sessionId, entry.tasks.map((task) => task.taskId)]), [[SESSION_ID, ['wf1']]]);
    assert.equal(script.released(), false, 'stdin stays open while the workflow runs');

    // The user stops it. The CLI answers with a `stopped` notification and
    // pushes no follow-up turn, so nothing else would ever end the hold.
    assert.equal(await stopClaudeSDKTask(SESSION_ID, 'wf1'), true);
    assert.deepEqual(script.stopped, ['wf1']);
    script.emit(taskNotification('wf1', 'toolu_wf', 'stopped'));
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'the process is let go once nothing is outstanding');
    void done;
  });
});

test('a task that reported completed keeps the hold for the turn that relays its result', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_wf', 'Workflow', { script: 'export const meta = {}' }));
    script.emit(taskStarted('wf1', 'toolu_wf', 'local_workflow'));
    script.emit(ack('toolu_wf', 'Workflow launched in background. Task ID: wf1', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow' }));
    script.emit(result());
    await settle();

    // Completed, unlike stopped, is followed by a turn the CLI pushes to relay
    // the result; closing stdin at the notification would cut it short.
    script.emit(taskNotification('wf1', 'toolu_wf', 'completed'));
    await settle();
    assert.equal(script.released(), false);

    script.emit(result());
    await settle();
    assert.equal(script.released(), true, 'the follow-up turn\'s result ends the hold');
  });
});

test('an agent that ran in the foreground and settled before the result does not hold the process', async () => {
  await withRun(async ({ script }) => {
    // An Agent call without `run_in_background` is scored as background by
    // the static rule, but the CLI ran it in the foreground: its task started
    // and settled before the turn ended. The task events know that.
    script.emit(init());
    script.emit(toolUse('toolu_agent', 'Agent', { prompt: 'Return the word FOUR', subagent_type: 'general-purpose' }));
    script.emit(taskStarted('a1', 'toolu_agent', 'local_agent'));
    script.emit(taskNotification('a1', 'toolu_agent', 'completed'));
    script.emit(ack('toolu_agent', 'FOUR', { status: 'completed', agentId: 'a1' }));
    script.emit(result());
    await settle();

    assert.deepEqual(listClaudeSDKBackgroundWork(), []);
    assert.equal(script.released(), true, 'nothing is outstanding, so nothing to hold for');
  });
});

test('a turn whose tool emits no task events still holds on the static rule', async () => {
  await withRun(async ({ script }) => {
    script.emit(init());
    script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
    script.emit(ack('toolu_monitor', 'Monitor started', {}));
    script.emit(result());
    await settle();

    assert.equal(script.released(), false, 'Monitor reports no task, so the launch rule decides');
  });
});


test('another prompt reuses the live CLI and routes its completion to the new writer', async () => {
  await withRun(async ({script,sent,continueRun}) => {
    script.emit(init());
    script.emit(toolUse('toolu_bg','Bash',{command:'long running command',run_in_background:true}));
    script.emit(taskStarted('bg1','toolu_bg','local_bash'));
    script.emit(result());
    await waitFor(() => sent.some(m => m.kind === 'complete'));
    const next: NormalizedMessage[] = [];
    const continued = continueRun({send:(m:NormalizedMessage)=>next.push(m),userId:null},{permissionMode:'plan',cloudcliMonitorReportContext:'NEW_REPORT'});
    await waitFor(()=>script.prompts.length===2);
    assert.equal(script.released(),false,'old stdin must remain open');
    assert.deepEqual(script.stopped,[],'no stopTask is sent');
    assert.equal(script.prompts.length,2,'new prompt reaches the same input stream');
    assert.deepEqual(script.modes,['plan'],'permission changes apply to the existing process');
    assert.deepEqual(await script.context(),{hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'NEW_REPORT'}});
    assert.deepEqual(await script.context(),{},'the report is only added once');
    assert.equal((script.prompts.at(-1) as any).message.content,'second prompt');
    assert.equal(next.some(m=>m.kind==='complete'),false,'no premature completion');
    script.emit({...result(),user_message_uuid:'unrelated-background-notification'});
    await settle();
    assert.equal(next.some(m=>m.kind==='complete'),false,'a background reply cannot finish the new prompt');
    script.emit({type:'assistant',session_id:NATIVE_ID,message:{role:'assistant',content:[{type:'text',text:'second reply'}]}});
    script.emit(result());
    await continued;
    assert.equal(next.filter(m=>m.kind==='complete').length,1);
    assert.equal(sent.filter(m=>m.kind==='complete').length,1,'old writer is not reused');
    assert.equal(script.released(),false,'background command survives both turns');
    assert.equal(listClaudeSDKBackgroundWork()[0]?.tasks[0]?.taskId,'bg1');
    script.emit(taskNotification('bg1','toolu_bg','completed'));
    script.emit(result());
    await waitFor(()=>script.released());
  });
});

test('rewinding a live background session is rejected without stopping its work', async () => {
  await withRun(async ({script,sent,continueRun}) => {
    script.emit(init());
    script.emit(toolUse('toolu_bg','Bash',{run_in_background:true}));
    script.emit(taskStarted('bg1','toolu_bg','local_bash'));
    script.emit(result());
    await waitFor(()=>sent.some(m=>m.kind==='complete'));
    await assert.rejects(continueRun({send:()=>{},userId:null},{resumeFromScratch:true}),/background/i);
    assert.equal(script.released(),false);
    assert.deepEqual(script.stopped,[]);
    assert.equal(script.prompts.length,1);
  });
});

test('a process exit before the continued reply reports failure rather than success', async () => {
  await withRun(async ({script,sent,continueRun}) => {
    script.emit(init());
    script.emit(toolUse('toolu_bg','Bash',{run_in_background:true}));
    script.emit(taskStarted('bg1','toolu_bg','local_bash'));
    script.emit(result());
    await waitFor(()=>sent.some(m=>m.kind==='complete'));
    const next: NormalizedMessage[] = [];
    const continued = continueRun({send:(m:NormalizedMessage)=>next.push(m),userId:null});
    const rejected = assert.rejects(continued,/ended before/);
    await waitFor(()=>script.prompts.length===2);
    script.end();
    await rejected;
    assert.equal(next.find(m=>m.kind==='complete')?.exitCode,1);
  });
});
