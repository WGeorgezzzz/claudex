import { act,renderHook,waitFor } from '@testing-library/react';
import { beforeEach,expect,it,vi } from 'vitest';
import type { KeyboardEvent,RefObject } from 'react';
import type { LLMProvider,Project } from '@/shared/types';
const mocks=vi.hoisted(()=>({list:vi.fn(),skills:vi.fn()}));
vi.mock('@/shared/api',()=>({api:{commands:{list:mocks.list},providers:{skills:mocks.skills}}}));
import { useSlashCommands } from '@/modules/chat/hooks/useSlashCommands';
const projects:Record<string,Project>={'/work':{projectId:'p',displayName:'Fixture',fullPath:'/work'},'/other':{projectId:'p',displayName:'Fixture',fullPath:'/other'}};
const response=(data:unknown)=>({ok:true,json:async()=>data});
beforeEach(()=>{localStorage.clear();mocks.list.mockReset().mockResolvedValue(response({builtIn:[{name:'/compact',type:'skill',namespace:'builtin',metadata:{type:'skill'}}]}));mocks.skills.mockReset().mockResolvedValue(response({data:{skills:[{name:'systematic-debugging',command:'$systematic-debugging',description:'Find root causes',scope:'project',sourcePath:'/work/.agents/skills/systematic-debugging/SKILL.md',argumentHint:'[issue]'}]}}));});
it('Codex dollar completion fuzzy matches skills and Enter inserts the native invocation without executing',async()=>{
 let input='$sydbg';const setInput=vi.fn(),execute=vi.fn(),textarea=document.createElement('textarea'),ref={current:textarea} as RefObject<HTMLTextAreaElement>;
 textarea.value=input;textarea.setSelectionRange(input.length,input.length);
 const {result,rerender}=renderHook(()=>useSlashCommands({selectedProject:projects['/work'],provider:'codex',input,setInput,textareaRef:ref,onExecuteCommand:execute}));await waitFor(()=>expect(result.current.slashCommands).toHaveLength(2));
 act(()=>result.current.handleCommandInputChange('$sydbg',6));await waitFor(()=>expect(result.current.filteredCommands.map(c=>c.name)).toEqual(['$systematic-debugging']));act(()=>result.current.handleCommandMenuKeyDown({key:'Enter',preventDefault(){}} as KeyboardEvent<HTMLTextAreaElement>));expect(setInput).toHaveBeenCalledWith('$systematic-debugging ');expect(execute).not.toHaveBeenCalled();
 input='/comp';textarea.value=input;textarea.setSelectionRange(5,5);rerender();act(()=>result.current.handleCommandInputChange('/comp',5));await waitFor(()=>expect(result.current.filteredCommands[0]?.name).toBe('/compact'));act(()=>result.current.handleCommandMenuKeyDown({key:'Tab',preventDefault(){}} as KeyboardEvent<HTMLTextAreaElement>));expect(setInput).toHaveBeenLastCalledWith('/compact ');expect(execute).not.toHaveBeenCalled();
});
it('harness and cwd changes use their own catalog and refresh invalidates the local cache',async()=>{
 const ref={current:document.createElement('textarea')} as RefObject<HTMLTextAreaElement>;const {result,rerender}=renderHook(({provider,cwd}:{provider:LLMProvider;cwd:string})=>useSlashCommands({selectedProject:projects[cwd],provider,input:'',setInput:vi.fn(),textareaRef:ref,onExecuteCommand:vi.fn()}),{initialProps:{provider:'codex' as LLMProvider,cwd:'/work'}});await waitFor(()=>expect(result.current.slashCommands).toHaveLength(2));rerender({provider:'claude',cwd:'/other'});await waitFor(()=>expect(mocks.list).toHaveBeenCalledWith('/other','claude'));await waitFor(()=>expect(mocks.skills).toHaveBeenCalledTimes(2));mocks.skills.mockResolvedValue(response({data:{skills:[{name:'new',command:'/new',scope:'user'}]}}));act(()=>window.dispatchEvent(new Event('nexagent:skills-refresh')));await waitFor(()=>expect(result.current.slashCommands.some(c=>c.name==='/new')).toBe(true));
});
