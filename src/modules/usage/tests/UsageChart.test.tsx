import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { UsageChart } from '@/modules/usage/UsageChart';
import type { UsageSeries } from '@/shared/types';

vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
afterEach(cleanup);
const buckets=Array.from({length:30},(_,i)=>`2026-10-${String(i+1).padStart(2,'0')}`);
const series:UsageSeries[]=Array.from({length:9},(_,i)=>({key:String(i),label:`model-${i}`,points:buckets.map(t=>({t,requests:1,input:i,output:0,cacheRead:0,cacheWrite:0,total:i}))}));
test('more than eight series are merged without losing totals; legend controls both lines and stacked areas',()=>{
 const {container,rerender}=render(<UsageChart buckets={buckets} series={series} metric="total" area={false}/>);
 expect(screen.getAllByRole('button')).toHaveLength(8);expect(screen.getByText('usage.other')).toBeTruthy();
 expect(container.querySelectorAll('polyline')).toHaveLength(8);
 fireEvent.keyDown(screen.getByRole('img'),{key:'ArrowRight'});expect(screen.getByRole('status').textContent).toContain('usage.other1');
 const legend=screen.getByRole('button',{name:'model-8'});fireEvent.click(legend);expect(legend.getAttribute('aria-pressed')).toBe('false');expect(container.querySelectorAll('polyline')).toHaveLength(7);
 rerender(<UsageChart buckets={buckets} series={series} metric="total" area/>);expect(container.querySelectorAll('polygon')).toHaveLength(7);
});
test('keyboard tooltip safely handles shrinking ranges and an empty loading response',()=>{
 const {rerender}=render(<UsageChart buckets={buckets} series={series} metric="total" area={false}/>);
 for(let i=0;i<35;i++)fireEvent.keyDown(screen.getByRole('img'),{key:'ArrowRight'});
 expect(screen.getByRole('status').textContent).toContain('2026-10-30');
 rerender(<UsageChart buckets={buckets.slice(0,24)} series={series.map(s=>({...s,points:s.points.slice(0,24)}))} metric="total" area={false}/>);expect(screen.queryByRole('status')).toBeNull();
 rerender(<UsageChart buckets={[]} series={[]} metric="total" area={false}/>);fireEvent.pointerMove(screen.getByRole('img'));expect(screen.queryByRole('status')).toBeNull();expect(screen.getByText('usage.empty')).toBeTruthy();
});
