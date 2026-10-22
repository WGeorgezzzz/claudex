import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import { readClaudeNextPrompts } from '@/shared/utils';
import type { ChatMessage } from '@/shared/types';
import { NextPromptSuggestions } from '@/modules/chat/composer/NextPromptSuggestions';

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
