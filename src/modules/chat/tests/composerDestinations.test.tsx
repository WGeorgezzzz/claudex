import assert from 'node:assert/strict';

import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import ChatComposer from '@/modules/chat/composer/ChatComposer';

vi.mock('@/modules/chat/hooks/useVoiceAvailable',()=>({useVoiceAvailable:()=>true}));
vi.mock('@/modules/chat/hooks/useVoiceInput',()=>({useVoiceInput:()=>({state:'idle',toggle:vi.fn(),stop:vi.fn()})}));

function props(overrides:Partial<ComponentProps<typeof ChatComposer>>={}):ComponentProps<typeof ChatComposer>{
  const noop=()=>undefined;
  return {
    compact:true,pendingPermissionRequests:[],handlePermissionDecision:noop,handleGrantToolPermission:()=>({success:true}),activity:null,
    isLoading:true,onAbortSession:noop,permissionMode:'default',availablePermissionModes:[],onSelectPermissionMode:noop,
    providerLabel:'Claude',effort:'medium',availableEffortOptions:[],onSelectEffort:noop,model:'model',availableModelOptions:[],onSelectModel:noop,modelsLoading:false,
    tokenBudget:null,onShowTokenUsage:noop,slashCommandsCount:0,onToggleCommandMenu:noop,hasInput:true,onClearInput:noop,onSubmit:noop,isDragActive:false,
    backgroundSendPrompt:null,onResolveBackgroundSendPrompt:noop,isEditingSentMessage:false,onCancelEditMessage:noop,scheduledMessages:[],onScheduleMessage:noop,onCancelScheduledMessage:noop,
    attachedFiles:[],onRemoveAttachment:noop,fileErrors:new Map(),showFileDropdown:false,filteredFiles:[],selectedFileIndex:0,onSelectFile:noop,
    filteredCommands:[],selectedCommandIndex:0,onCommandSelect:noop,onCloseCommandMenu:noop,isCommandMenuOpen:false,frequentCommands:[],
    getRootProps:()=>({}),getInputProps:()=>({type:'file'}),openAttachmentPicker:noop,inputHighlightRef:{current:null},renderInputWithMentions:text=>text,
    textareaRef:{current:null},input:'plain text',onVoiceTranscript:noop,onInputChange:noop,onTextareaClick:noop,onTextareaKeyDown:noop,onTextareaPaste:noop,onTextareaScrollSync:noop,onTextareaInput:noop,
    placeholder:'Message',isTextareaExpanded:false,busySendMode:'insert',supportsLiveInput:true,onBusySendModeChange:noop,...overrides,
  };
}

test('running empty input keeps stop and shows no destination row',()=>{
  render(<ChatComposer {...props({input:''})}/>);
  assert.equal(screen.queryByRole('group',{name:'Message destination while running'}),null);
  assert.ok(screen.getByRole('button',{name:/^Stop$/}));
});

test('plain text shows the selected destination without a footer select or duplicate queue action',()=>{
  const change=vi.fn();render(<ChatComposer {...props({onBusySendModeChange:change})}/>);
  const group=screen.getByRole('group',{name:'Message destination while running'});
  assert.equal(group.querySelector('button')?.getAttribute('aria-pressed'),'true');
  assert.equal(screen.queryByRole('combobox'),null);
  fireEvent.click(group.querySelectorAll('button')[1]);assert.deepEqual(change.mock.calls,[['queue']]);
});

for(const [name,overrides,reason] of [
  ['attachments',{attachedFiles:[new File(['data'],'note.txt')]},'Attachments send next turn'],
  ['slash command',{input:'/compact'},'Commands send next turn'],
  ['editing a sent message',{isEditingSentMessage:true},'Edited messages send next turn'],
] satisfies Array<[string,Partial<ComponentProps<typeof ChatComposer>>,string]>){
  test(`${name} visibly disables insertion and selects next turn`,()=>{
    render(<ChatComposer {...props(overrides)}/>);
    const buttons=screen.getByRole('group',{name:'Message destination while running'}).querySelectorAll('button');
    assert.equal(buttons[0].disabled,true);assert.equal(buttons[0].title,reason);
    assert.equal(buttons[1].getAttribute('aria-pressed'),'true');
    assert.equal(screen.getAllByRole('button',{name:'Send next turn'}).length,2);
  });
}

test('providers without live input expose only the next-turn send action',()=>{
  render(<ChatComposer {...props({supportsLiveInput:false,providerLabel:'Cursor'})}/>);
  assert.equal(screen.queryByRole('button',{name:'Insert into current task'}),null);
  assert.ok(screen.getByRole('button',{name:'Send next turn'}));
});
