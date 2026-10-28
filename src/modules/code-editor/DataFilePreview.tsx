import { useEffect, useState } from 'react';
import { api, readApiJson } from '@/shared/api';

export function parseDelimited(text:string, separator:string):string[][] {
  const rows:string[][]=[];let row:string[]=[];let field='';let quoted=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(c==='"') {if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
    else if(c===separator&&!quoted){row.push(field);field='';}
    else if(c==='\n'&&!quoted){row.push(field.replace(/\r$/,''));rows.push(row);row=[];field='';if(rows.length>=1000)return rows;}
    else field+=c;
  }
  if(field||row.length){row.push(field);rows.push(row);}return rows;
}
export default function DataFilePreview({name,content,projectId,path,size=0,initialOffset=0,truncated=false}: {name:string;content:string;projectId?:string;path:string;size?:number;initialOffset?:number;truncated?:boolean}) {
  const [text,setText]=useState(content);const [offset,setOffset]=useState(initialOffset);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  useEffect(()=>{setText(content);setOffset(initialOffset);setError('');},[content,path,initialOffset]);
  const page=async(next:number)=>{if(!projectId)return;setBusy(true);try{const data=await readApiJson<{content:string;offset:number}>(await api.readFile(projectId,path,{offset:next}));setText(data.content);setOffset(data.offset);}catch(e){setError(String(e));}finally{setBusy(false);}};
  const table=/\.(csv|tsv)$/i.test(name);let display=text;let formatError='';
  if(/\.jsonl?$/i.test(name)) {try{display=/\.jsonl$/i.test(name)?text.split(/\r?\n/).filter(Boolean).slice(0,1000).map(line=>JSON.stringify(JSON.parse(line),null,2)).join('\n'):JSON.stringify(JSON.parse(text),null,2);}catch{formatError=truncated?'当前分页包含不完整 JSON，显示原文':'JSON 格式无效，显示原文';}}
  return <div className="h-full overflow-auto p-3">
    {truncated&&<div role="status" className="mb-2 flex flex-wrap gap-2">文件 {size.toLocaleString()} 字节；超过 1 MiB 只读分页，每页 256 KiB；当前位置 {offset}。分页边界可能截断字符或记录。
      {([['首页',0],['上一页',Math.max(0,offset-262144)],['下一页',Math.min(Math.max(0,size-262144),offset+262144)],['末页',Math.max(0,size-262144)]] as const).map(([label,next])=><button disabled={busy} className="rounded border p-1" key={label} onClick={()=>void page(next)}>{label}</button>)}
    </div>}
    {error&&<p role="alert">{error}</p>}{formatError&&<p role="status">{formatError}</p>}
    {table?<><p>最多显示 1000 行、100 列；其余内容可切换源码查看。</p><table className="w-full border-collapse text-sm"><tbody>{parseDelimited(text,/\.tsv$/i.test(name)?'\t':',').map((row,i)=><tr key={i}>{row.slice(0,100).map((cell,j)=><td className="whitespace-pre-wrap border p-2" key={j}>{cell}</td>)}</tr>)}</tbody></table></>:<pre className="whitespace-pre-wrap break-all text-xs">{display}</pre>}
  </div>;
}
