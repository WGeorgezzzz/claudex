import { describe,it,expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { invocationRanges,unknownInvocation,renderInvocationTokens,removeInvocationAtCaret } from '@/modules/chat/utils/invocationTokens';
import type { SlashCommand } from '@/shared/types';
const commands=[{name:'$review',type:'skill'},{name:'/review:security',type:'skill'},{name:'/help',type:'built-in'}] as SlashCommand[];
describe('native invocation tokens',()=>{
 it('only recognizes exact catalog entries with native boundaries',()=>{expect(invocationRanges('$review $reviewer /review:security /missing',commands).map(r=>r.name)).toEqual(['$review','/review:security']);expect(unknownInvocation('$unknown',commands,'codex')).toBe('$unknown');expect(unknownInvocation('$unknown',commands,'claude')).toBe('');});
 it('highlights known files including spaces and leaves unknown text alone',()=>{const html=renderToStaticMarkup(<>{renderInvocationTokens('$review @"src/my file.ts" @missing',commands,['src/my file.ts'])}</>);expect(html).toContain('data-invocation-token="skill"');expect(html).toContain('data-invocation-token="file"');expect(html).toContain('@missing');expect(invocationRanges('@missing',commands,['src/my file.ts'])).toEqual([]);});
 it('deletes tokens atomically without eating neighboring words',()=>{expect(removeInvocationAtCaret('do $review now',11,'Backspace',commands)).toEqual({text:'do now',caret:3});expect(removeInvocationAtCaret('$review next',2,'Delete',commands)).toEqual({text:' next',caret:0});expect(removeInvocationAtCaret('$unknown',8,'Backspace',commands)).toBeNull();});
});
