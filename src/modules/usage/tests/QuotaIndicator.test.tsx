import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { QuotaIndicator } from '@/modules/usage/QuotaIndicator';
const fixture=vi.hoisted(()=>({error:'',status:'ok',stale:false}));
vi.mock('@/modules/usage/hooks/useQuota',()=>({useQuota:()=>({data:{local:[{provider:'claude',status:'unavailable',windows:[],note:'页面未连接'},{provider:'codex',status:fixture.status,windows:fixture.status==='ok'?[{label:'7 天',usedPercent:3,remainingPercent:97}]:[],checkedAt:'2026-10-28T00:00:00Z',lastSuccess:{checkedAt:'2026-10-28T00:00:00Z',windows:[{label:'7 天',usedPercent:3,remainingPercent:97}]}}]},error:fixture.error,now:Date.parse('2026-10-28T01:00:00Z')})}));
afterEach(()=>{cleanup();fixture.error='';fixture.status='ok';});
test('a disconnected source cannot hide the other source or its stale value',()=>{render(<QuotaIndicator onOpen={()=>{}}/>);expect(screen.getByText('未连接')).toBeTruthy();expect(screen.getByText('7 天 已用 3%')).toBeTruthy();expect(screen.getByText('60 分钟前')).toBeTruthy();});
test('failed refresh retains last success and explains its age',()=>{fixture.status='error';fixture.error='offline';render(<QuotaIndicator onOpen={()=>{}}/>);expect(screen.getByText('7 天 已用 3%')).toBeTruthy();expect(screen.getByText('读取失败（上次 60 分钟前）')).toBeTruthy();expect(screen.getByTestId('quota-indicator')).toBeTruthy();});
