import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WorkBuddyProvider } from '../../server/modules/providers/list/workbuddy/workbuddy.provider.js';

const provider = new WorkBuddyProvider();
const root = process.env.WORKBUDDY_VERIFY_DIR;
if (!root) throw new Error('Set WORKBUDDY_VERIFY_DIR to an isolated verification directory.');
mkdirSync(root, { recursive: true });
const auth = await provider.auth.getStatus();
assert.equal(auth.authenticated, true, auth.error);
let nativeId: string | null = null;
let events: any[] = [];
const writer = { send: (event: any) => events.push(event), setSessionId: (id: string) => { nativeId = id; } };
const context = {
  resolveProviderSessionId: () => nativeId,
  resolveResumeModel: async () => 'fast-model',
  getProviderModels: () => provider.models.getSupportedModels(),
  normalizeMessage: (raw: unknown, id: string | null) => provider.sessions.normalizeMessage(raw, id),
  isProviderInstalled: async () => true,
};
await provider.runtime.run('Remember the marker PLUM_70319 for this conversation. Reply with exactly WORKBUDDY_IN_CLAUDEX_OK. Do not use tools.', { cwd: root }, writer, context);
assert(events.some(event => event.kind === 'text' && event.content?.trim() === 'WORKBUDDY_IN_CLAUDEX_OK'));
assert.equal(events.filter(event => event.kind === 'complete').length, 1);
assert.equal(events.find(event => event.kind === 'complete')?.success, true);
writeFileSync(path.join(root, 'turn-1.json'), JSON.stringify(events, null, 2));
events = [];
await provider.runtime.run('What was the marker I asked you to remember? Reply with only the marker. Do not use tools.', { cwd: root }, writer, context);
assert(events.some(event => event.kind === 'text' && event.content?.trim() === 'PLUM_70319'));
assert.equal(events.filter(event => event.kind === 'complete').length, 1);
const history = await provider.sessions.fetchHistory(nativeId!);
assert.equal(history.messages.filter(message => message.role === 'user').length, 2);
assert.equal(history.messages.filter(message => message.role === 'assistant').length, 2);
writeFileSync(path.join(root, 'turn-2.json'), JSON.stringify(events, null, 2));
writeFileSync(path.join(root, 'summary.json'), JSON.stringify({ auth: true, newConversation: true, resume: true, history: history.total, nativeId }, null, 2));
console.log(JSON.stringify({ auth: true, newConversation: true, resume: true, history: history.total, nativeId }));
