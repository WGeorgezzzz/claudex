import { createContext } from 'react';
import type { SlashCommand } from '@/shared/types';
export const InvocationCatalogContext=createContext<{commands:SlashCommand[];files:string[]}>({commands:[],files:[]});
type Range={start:number;end:number;name:string;kind:'skill'|'command'|'file'};
export function invocationRanges(text:string,commands:SlashCommand[],files:string[]=[]):Range[]{
  const known=new Map<string,Range['kind']>(commands.map(c=>[c.name,c.type==='skill'||c.namespace==='skill'?'skill':'command']));
  for(const file of files){known.set('@'+file,'file');known.set('@"'+file+'"','file');}
  const names=[...known.keys()].filter(Boolean).sort((a,b)=>b.length-a.length);if(!names.length)return [];
  const escaped=names.map(n=>n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
  const expression=new RegExp('(^|\\s)('+escaped.join('|')+')(?=$|[\\s,;!?])','g');
  return [...text.matchAll(expression)].map(match=>({start:match.index!+match[1].length,end:match.index!+match[0].length,name:match[2],kind:known.get(match[2])!}));
}
export function unknownInvocation(text:string,commands:SlashCommand[],provider:string):string {
  const known=new Set(commands.map(c=>c.name));const names=[...text.matchAll(/(?:^|\s)([$/][\p{L}\p{N}_.:-]+)(?=$|\s)/gu)].map(m=>m[1]);
  return names.find(n=>(n.startsWith('/')||provider==='codex'&&n.startsWith('$'))&&!known.has(n))||'';
}
/** Exact same character widths as the textarea; styling never shifts caret positions. */
export function renderInvocationTokens(text:string,commands:SlashCommand[],files:string[]=[],overlay=false){
  const ranges=invocationRanges(text,commands,files);if(!ranges.length)return text;
  const nodes=[];let offset=0;for(const range of ranges){nodes.push(text.slice(offset,range.start));nodes.push(<span key={range.start} data-invocation-token={range.kind} className={'rounded-md box-decoration-clone '+(range.kind==='file'?'bg-blue-200/70 dark:bg-blue-300/30':'bg-violet-200/70 dark:bg-violet-400/25')+(overlay?' text-transparent':' px-0.5 font-medium')} title={range.kind==='file'?'文件引用':range.kind==='skill'?'技能':'命令'}>{range.name}</span>);offset=range.end;}nodes.push(text.slice(offset));return nodes;
}
export function removeInvocationAtCaret(text:string,caret:number,key:string,commands:SlashCommand[],files:string[]=[]){
  if(key!=='Backspace'&&key!=='Delete')return null;
  const range=invocationRanges(text,commands,files).find(r=>key==='Backspace'?(caret>r.start&&caret<=r.end||caret===r.end+1&&/\s/.test(text[r.end]||'')):caret>=r.start&&caret<r.end);
  if(!range)return null;const end=caret>range.end?caret:range.end;return {text:text.slice(0,range.start)+text.slice(end),caret:range.start};
}
