import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { UsageCounts, UsageSeries } from '@/shared/types';

const COLORS = ['#2563eb','#db2777','#059669','#d97706','#7c3aed','#0891b2','#dc2626','#64748b'];
/** Usage dashboard renders a responsive SVG; visibility is keyed by series identity rather than index. */
export function UsageChart({series,buckets,metric,area}:{series:UsageSeries[];buckets:string[];metric:keyof UsageCounts;area:boolean}) {
  const {t}=useTranslation('settings');
  const container=useRef<HTMLDivElement>(null);
  // Match SVG coordinates to rendered pixels so axes remain legible on 360px phones.
  const [width,setWidth]=useState(800);
  useEffect(()=>{const element=container.current;if(!element||typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(entries=>setWidth(Math.max(240,entries[0].contentRect.width)));observer.observe(element);return()=>observer.disconnect();},[]);
  // Legend choices persist across metric changes without altering the underlying totals.
  const [hidden,setHidden]=useState<Set<string>>(new Set());
  // Pointer position selects one bucket, also available through keyboard arrows.
  const [hover,setHover]=useState<number|null>(null);
  const selected=hover!==null&&hover<buckets.length?hover:null;
  const groups=useMemo(()=>{
    const ranked=[...series].sort((a,b)=>b.points.reduce((s,p)=>s+p[metric],0)-a.points.reduce((s,p)=>s+p[metric],0));
    if(ranked.length<=8)return ranked;
    const rest=ranked.slice(7),points=buckets.map((time,i)=>({t:time,requests:0,input:0,output:0,cacheRead:0,cacheWrite:0,total:0,...Object.fromEntries(['requests','input','output','cacheRead','cacheWrite','total'].map(k=>[k,rest.reduce((s,r)=>s+(r.points[i]?.[k as keyof UsageCounts]||0),0)]))}));
    return [...ranked.slice(0,7),{key:'__other',label:t('usage.other'),points}];
  },[series,buckets,metric,t]);
  const visible=groups.filter(s=>!hidden.has(s.key));
  const rawMax=Math.max(1,...buckets.map((_,i)=>area?visible.reduce((s,r)=>s+r.points[i][metric],0):Math.max(0,...visible.map(r=>r.points[i][metric]))));
  const magnitude=10**Math.floor(Math.log10(rawMax/4)),step=Math.ceil(rawMax/4/magnitude)*magnitude,max=step*4;
  const height=width<480?230:285,bottom=height-40;
  const x=(i:number)=>52+i*(width-74)/Math.max(1,buckets.length-1),y=(v:number)=>bottom-v/max*(bottom-25);
  const fmt=(v:number)=>v>=1e6?`${+(v/1e6).toFixed(1)}M`:v>=1e3?`${+(v/1e3).toFixed(1)}K`:v.toLocaleString();
  const label=(v:string)=>buckets.length===24?v.slice(11,16):v.slice(5);
  const stacks=buckets.map(()=>0);
  return <div className="min-w-0 rounded-xl border border-border bg-card p-3" data-testid="usage-chart">
    <div ref={container} className="relative" onPointerLeave={()=>setHover(null)}>
      <svg className="block w-full text-muted-foreground" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('usage.chart')} tabIndex={0}
        onKeyDown={e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();setHover(Math.max(0,Math.min(buckets.length-1,(hover??0)+(e.key==='ArrowRight'?1:-1))));}}}
        onPointerMove={e=>{if(!buckets.length)return;const r=e.currentTarget.getBoundingClientRect();setHover(Math.max(0,Math.min(buckets.length-1,Math.round(((e.clientX-r.left)/r.width*width-52)/(width-74)*(buckets.length-1)))));}}>
        {[0,1,2,3,4].map(i=><g key={i}><line x1="52" x2={width-22} y1={y(i*step)} y2={y(i*step)} stroke="currentColor" opacity=".15"/><text x="45" y={y(i*step)+4} textAnchor="end" fontSize="11" fill="currentColor">{fmt(i*step)}</text></g>)}
        {visible.map(s=>{const color=COLORS[groups.indexOf(s)],base=[...stacks];const top=s.points.map((p,i)=>{const v=p[metric]+(area?stacks[i]:0);if(area)stacks[i]=v;return `${x(i)},${y(v)}`;});return <g key={s.key}>{area&&<polygon points={[...top,...base.map((v,i)=>`${x(i)},${y(v)}`).reverse()].join(' ')} fill={color} opacity=".3"/>}<polyline fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" points={top.join(' ')}/></g>;})}
        {buckets.map((b,i)=>i%Math.ceil(buckets.length/(width<480?3:5))===0||i===buckets.length-1?<text key={b} x={x(i)} y={height-12} textAnchor="middle" fontSize="11" fill="currentColor">{label(b)}</text>:null)}
        {selected!==null&&<line x1={x(selected)} x2={x(selected)} y1="20" y2={bottom} stroke="currentColor" strokeDasharray="4 3"/>}
      </svg>
      {selected!==null&&<div role="status" className="pointer-events-none absolute top-1 z-10 max-h-52 w-56 max-w-full overflow-y-auto rounded-lg border border-border bg-background/95 p-3 text-xs text-foreground shadow-lg" style={{[selected>buckets.length/2?'right':'left']:0}}>
        <div className="mb-2 font-semibold">{buckets[selected].replace('T',' ').replace(':00:00+08:00',':00')}</div>
        {visible.map(s=><div key={s.key} className="flex justify-between gap-3 py-0.5"><span className="truncate" style={{color:COLORS[groups.indexOf(s)]}}>{s.label}</span><span>{s.points[selected][metric].toLocaleString()}</span></div>)}
      </div>}
      {!series.length&&<div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">{t('usage.empty')}</div>}
    </div>
    <div className="flex flex-wrap gap-x-4 gap-y-2">{groups.map((s,i)=><button type="button" key={s.key} aria-pressed={!hidden.has(s.key)} onClick={()=>setHidden(old=>{const next=new Set(old);if(next.has(s.key))next.delete(s.key);else next.add(s.key);return next;})} className={`flex max-w-full items-center gap-1.5 text-xs ${hidden.has(s.key)?'opacity-40':''}`}><span className="h-2 w-2 shrink-0 rounded-full" style={{background:COLORS[i]}}/><span className="truncate">{s.label}</span></button>)}</div>
  </div>;
}
