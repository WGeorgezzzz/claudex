import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import { readClaudeNextPrompts } from '@/shared/utils';
import type { ChatMessage } from '@/shared/types';
import { NextPromptSuggestions } from '@/modules/chat/composer/NextPromptSuggestions';
import { api } from '@/shared/api';

const content='Done.\n<claudex_next_prompts>["Check the result", "Review the diff"]</claudex_next_prompts>';
const message={id:'a',type:'assistant',content,timestamp:'2026-10-22T00:00:00Z'} as ChatMessage;
test('valid suggestions are stripped from prose and clicks only fill the draft',()=>{
  assert.deepEqual(readClaudeNextPrompts(content),{content:'Done.',prompts:['Check the result','Review the diff']});
  const insert=vi.fn();const view=render(<NextPromptSuggestions messages={[message]} busy={false} onInsert={insert}/>);
  fireEvent.click(screen.getByRole('button',{name:'Review the diff'}));assert.deepEqual(insert.mock.calls,[['Review the diff']]);
  view.rerender(<NextPromptSuggestions messages={[message]} busy onInsert={insert}/>);assert.equal(screen.queryAllByRole('button').length,0);
  view.rerender(<NextPromptSuggestions messages={[message,{id:'u',type:'user',content:'new task',timestamp:'2026-10-22T00:01:00Z'} as ChatMessage]} busy={false} onInsert={insert}/>);assert.equal(screen.queryAllByRole('button').length,0);
});
test('invalid, quoted and incomplete suggestion data never becomes an action',()=>{
  for(const value of ['[{}]','["a","b","c","d"]','[""]','not json'])assert.equal(readClaudeNextPrompts(`<claudex_next_prompts>${value}</claudex_next_prompts>`).prompts.length,0);
  assert.equal(readClaudeNextPrompts('```xml\n'+content+'\n```').prompts.length,0);
  assert.equal(readClaudeNextPrompts('Answer\n<claudex_next_prompts>["unfinished',true).content,'Answer');
});

test('an untagged reply never becomes stock template buttons',()=>{
  render(<NextPromptSuggestions messages={[{...message,content:'The result is ready.'}]} busy={false} onInsert={vi.fn()}/>);
  assert.equal(screen.queryAllByRole('button').length,0);
});

const response=(replies:string[])=>({ok:true,json:async()=>({data:{status:'ready',replies}})}) as Response;

test('missing suggestions are generated for the displayed reply and only fill its draft',async()=>{
  const generate=vi.spyOn(api.providers,'replySuggestions').mockResolvedValue(response(['Choose the quieter garden in Suzhou.']));
  const insert=vi.fn();
  render(<NextPromptSuggestions messages={[{...message,content:'Humble Administrator Garden or Lingering Garden?'}]} sessionId="s1" provider="claude" busy={false} onInsert={insert}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Choose the quieter garden in Suzhou.'}));
  assert.deepEqual(insert.mock.calls,[['Choose the quieter garden in Suzhou.']]);
  assert.equal(generate.mock.calls[0][0],'s1');
  assert.equal(generate.mock.calls[0][1],'Humble Administrator Garden or Lingering Garden?');
});

test('a late result from another conversation cannot replace the current suggestions',async()=>{
  let finishFirst!:(response:Response)=>void;
  vi.spyOn(api.providers,'replySuggestions').mockImplementationOnce(()=>new Promise(resolve=>{finishFirst=resolve;})).mockResolvedValue(response(['Test Safari on an iPhone.']));
  const view=render(<NextPromptSuggestions messages={[{...message,content:'Choose a garden.'}]} sessionId="s1" provider="claude" busy={false} onInsert={vi.fn()}/>);
  view.rerender(<NextPromptSuggestions messages={[{...message,id:'b',content:'Test Safari or the session list?'}]} sessionId="s2" provider="claude" busy={false} onInsert={vi.fn()}/>);
  await screen.findByRole('button',{name:'Test Safari on an iPhone.'});
  await act(async()=>finishFirst(response(['Choose a garden in Suzhou.'])));
  assert.equal(screen.queryByRole('button',{name:'Choose a garden in Suzhou.'}),null);
});

test('generation failure shows an explicit retry instead of fabricated choices',async()=>{
  const generate=vi.spyOn(api.providers,'replySuggestions').mockRejectedValueOnce(new Error('offline')).mockResolvedValue(response(['Review the Safari keyboard test.']));
  render(<NextPromptSuggestions messages={[{...message,content:'The Safari test remains.'}]} sessionId="s1" provider="claude" busy={false} onInsert={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Retry'}));
  await screen.findByRole('button',{name:'Review the Safari keyboard test.'});
  await waitFor(()=>assert.equal(generate.mock.calls.length,2));
});

test('a just-completed transcript gets a bounded automatic retry before showing failure',async()=>{
  const generate=vi.spyOn(api.providers,'replySuggestions').mockResolvedValueOnce({ok:true,json:async()=>({data:{status:'stale',replies:[]}})} as Response)
    .mockResolvedValue(response(['Check the session-switching test.']));
  render(<NextPromptSuggestions messages={[{...message,content:'Session switching still needs checking.'}]} sessionId="s1" provider="claude" busy={false} onInsert={vi.fn()}/>);
  await screen.findByRole('button',{name:'Check the session-switching test.'},{timeout:3000});
  assert.equal(generate.mock.calls.length,2);
});
