import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, test, vi } from 'vitest';

import { DotDashboard } from '@/modules/dot/DotDashboard';
import { api } from '@/shared/api';

const response=(data:unknown)=>({ok:true,json:async()=>({data})}) as Response;
const snapshot={threads:[{sessionId:'dot-1',title:'Personal assistant',createdAt:'2026-01-01'}],memories:[{id:'m1',content:'Original memory',revision:3}],tasks:[]};
afterEach(()=>{cleanup();vi.restoreAllMocks();});

test('a stale memory write retains the user draft and exposes the conflict',async()=>{
  vi.spyOn(api.dot,'snapshot').mockResolvedValue(response(snapshot));
  const save=vi.spyOn(api.dot,'saveMemory').mockResolvedValue({ok:false,status:409,json:async()=>({error:{message:'Memory changed. Refresh before editing.'}})} as Response);
  render(<MemoryRouter><DotDashboard/></MemoryRouter>);
  fireEvent.click(screen.getByRole('button',{name:'Dot 个人助手'}));
  fireEvent.click(await screen.findByRole('button',{name:'记忆'}));
  fireEvent.click(await screen.findByRole('button',{name:'编辑'}));
  fireEvent.change(screen.getByLabelText('记忆内容'),{target:{value:'My unsaved correction'}});
  fireEvent.click(screen.getByRole('button',{name:'保存记忆'}));
  await waitFor(()=>assert.ok(screen.getByRole('alert').textContent?.includes('Memory changed')));
  assert.deepEqual(save.mock.calls[0],[{id:'m1',content:'My unsaved correction',revision:3}]);
  assert.equal((screen.getByLabelText('记忆内容') as HTMLTextAreaElement).value,'My unsaved correction');
});

test('opening an owned Dot conversation navigates to the complete workspace',async()=>{
  vi.spyOn(api.dot,'snapshot').mockResolvedValue(response(snapshot));
  function CurrentLocation(){return <output>{useLocation().pathname}</output>;}
  render(<MemoryRouter><DotDashboard/><CurrentLocation/></MemoryRouter>);
  fireEvent.click(screen.getByRole('button',{name:'Dot 个人助手'}));
  fireEvent.click(await screen.findByRole('button',{name:'Personal assistant'}));
  await waitFor(()=>assert.ok(screen.getByText('/session/dot-1')));
  assert.equal(screen.queryByRole('dialog'),null);
});
