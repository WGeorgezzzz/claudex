import assert from 'node:assert/strict';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { api } from '@/shared/api';
import type { SidebarProjectListProps, WorkspaceSectionsSnapshot } from '@/shared/types';
import { WorkspaceSectionsProvider } from '@/modules/sidebar/context/WorkspaceSectionsContext';
import { WorkspaceSections } from '@/modules/sidebar/WorkspaceSections';
import { SectionRow } from '@/modules/sidebar/SectionRow';

vi.mock('@/shared/api', () => ({ api: { workspaceSections: { list: vi.fn(), update: vi.fn() }, sessionBridge: { list: vi.fn() } }, readApiErrorMessage: (body: { message?: string }) => body.message }));
vi.mock('@/modules/sidebar/ProjectOrganization', () => ({ ProjectOrganization: () => <div>项目区</div> }));
vi.mock('@/modules/sidebar/SidebarProjectList', () => ({ default: () => <div>项目内容</div> }));
let snapshot: WorkspaceSectionsSnapshot;
const response = (data: unknown) => new Response(JSON.stringify({ data }));
const props = { projects: [], filteredProjects: [], activeSessions: new Set(), selectedSession: null } as unknown as SidebarProjectListProps;
function setup() {
  return render(<WorkspaceSectionsProvider><WorkspaceSections projectListProps={props} onSelect={vi.fn()}/><SectionRow target={{kind:'session',targetId:'chat',title:'测试会话'}}><a href="/session/chat">测试会话</a></SectionRow><SectionRow target={{kind:'project',targetId:'project',title:'测试项目'}}><button aria-expanded="true">测试项目</button></SectionRow></WorkspaceSectionsProvider>);
}
beforeEach(() => {
  vi.clearAllMocks(); snapshot = { revision: 1, sections: [], assignments: [], sessionItems: [] };
  vi.mocked(api.workspaceSections.list).mockImplementation(async () => response(snapshot));
  vi.mocked(api.workspaceSections.update).mockImplementation(async input => {
    assert.equal(input.revision, snapshot.revision);
    const next = structuredClone(snapshot); next.revision++;
    if (input.action === 'create' || input.action === 'create-assign') {
      if (next.sections.some(row => row.name === input.name)) return new Response(JSON.stringify({ message: '同名分区已存在' }), { status: 400 });
      const id = `section-${next.revision}`; next.sections.push({id,name:String(input.name).trim(),collapsed:false});
      if (input.action === 'create-assign') { next.assignments = next.assignments.filter(row => row.targetId !== input.targetId); next.assignments.push({kind:input.kind as 'session',targetId:String(input.targetId),sectionId:id}); }
    }
    if (input.action === 'assign') { next.assignments = next.assignments.filter(row => row.targetId !== input.targetId); if (input.sectionId) next.assignments.push({kind:input.kind as 'session',targetId:String(input.targetId),sectionId:String(input.sectionId)}); }
    if (input.action === 'reorder') { const from = next.sections.findIndex(row => row.id === input.id), to = next.sections.findIndex(row => row.id === input.beforeId); const [section] = next.sections.splice(from,1); next.sections.splice(to,0,section); }
    if (input.action === 'rename') next.sections.find(row => row.id === input.id)!.name = String(input.name);
    if (input.action === 'delete') { next.sections = next.sections.filter(row => row.id !== input.id); next.assignments = next.assignments.filter(row => row.sectionId !== input.id); }
    snapshot = next; return response(next);
  });
});
async function create(name: string) {
  fireEvent.click(await screen.findByRole('button',{name:'新建分区'}));
  const input = screen.getByRole('textbox',{name:'新分区名称'}); fireEvent.change(input,{target:{value:name}}); fireEvent.keyDown(input,{key:'Enter'});
  await waitFor(() => assert.ok(snapshot.sections.some(row => row.name === name)));
}
function transfer(payload: Record<string,string>) { return { types:Object.keys(payload), getData:(key:string)=>payload[key]??'', setData:vi.fn(), dropEffect:'move' }; }

test('visible plus creates inline from zero; Escape and empty blur cancel without writes', async () => {
  setup(); fireEvent.click(await screen.findByRole('button',{name:'新建分区'}));
  fireEvent.keyDown(screen.getByRole('textbox',{name:'新分区名称'}),{key:'Escape'}); assert.equal(screen.queryByRole('textbox'),null);
  fireEvent.click(screen.getByRole('button',{name:'新建分区'})); fireEvent.blur(screen.getByRole('textbox',{name:'新分区名称'})); assert.equal(screen.queryByRole('textbox'),null);
  assert.equal(vi.mocked(api.workspaceSections.update).mock.calls.length,0); await create('第一分区'); assert.equal(snapshot.sections.length,1);
});
test('overflow new-section performs one atomic creation and assignment; current check and remove work', async () => {
  setup(); await screen.findByRole('button',{name:'新建分区'});
  fireEvent.click(screen.getByRole('button',{name:'会话分区选项：测试会话'})); fireEvent.click(await screen.findByRole('menuitem',{name:'移到分区 ▸'}));
  const dialog = await screen.findByRole('dialog',{name:'移到分区'}); fireEvent.click(within(dialog).getByRole('menuitem',{name:/新建分区/}));
  fireEvent.change(within(dialog).getByRole('textbox'),{target:{value:'一步归类'}}); fireEvent.click(within(dialog).getByRole('button',{name:'创建并移入'}));
  await waitFor(()=>assert.equal(snapshot.assignments[0]?.targetId,'chat'));
  assert.equal(vi.mocked(api.workspaceSections.update).mock.calls.length,1); assert.equal(vi.mocked(api.workspaceSections.update).mock.calls[0][0].action,'create-assign');
  fireEvent.contextMenu(screen.getByRole('link',{name:'测试会话'})); const menu=await screen.findByRole('dialog',{name:'移到分区'});
  assert.equal(within(menu).getByRole('menuitemradio',{name:'一步归类'}).getAttribute('aria-checked'),'true');
  fireEvent.click(within(menu).getByRole('menuitem',{name:'移出分区'})); await waitFor(()=>assert.equal(snapshot.assignments.length,0));
});
test('typed project/session drops highlight, assign, remove on project area and reorder headers', async () => {
  const view=setup(); await create('一'); await create('二'); const ids=snapshot.sections.map(row=>row.id);
  const header=view.container.querySelector(`[data-section-header="${ids[0]}"]`)!;
  for (const kind of ['project','session']) {
    const data=transfer({'application/x-nexagent-section-item':JSON.stringify({kind,targetId:kind})});
    fireEvent.dragOver(header,{dataTransfer:data}); assert.match(header.className,/ring-2/); fireEvent.drop(header,{dataTransfer:data});
    await waitFor(()=>assert.ok(snapshot.assignments.some(row=>row.targetId===kind)));
  }
  fireEvent.drop(view.container.querySelector('[data-section-unassign]')!,{dataTransfer:transfer({'application/x-nexagent-section-item':JSON.stringify({kind:'session',targetId:'session'})})});
  await waitFor(()=>assert.equal(snapshot.assignments.length,1));
  fireEvent.drop(header,{dataTransfer:transfer({'application/x-nexagent-section':ids[1]})}); await waitFor(()=>assert.equal(snapshot.sections[0].id,ids[1]));
});
test('touch hold opens move menu, movement cancels and held click cannot navigate', async () => {
  const view=setup(); await screen.findByRole('button',{name:'新建分区'});
  const row=view.container.querySelector('[data-section-target="chat"]')!;
  // jsdom lacks PointerEvent; preserve touch metadata for the React handlers.
  const pointer=(type:string,x=0)=>{const event=new Event(type,{bubbles:true});Object.assign(event,{pointerType:'touch',clientX:x,clientY:0});fireEvent(row,event);};
  pointer('pointerdown'); pointer('pointermove',40); await new Promise(resolve=>setTimeout(resolve,600)); assert.equal(screen.queryByRole('dialog'),null);
  pointer('pointerdown'); await screen.findByRole('dialog',{name:'移到分区'}); pointer('pointerup');
  const click=new MouseEvent('click',{bubbles:true,cancelable:true}); row.dispatchEvent(click); assert.equal(click.defaultPrevented,true);
  fireEvent.click(screen.getByRole('button',{name:'取消'}));
  const projectButton=screen.getByRole('button',{name:'测试项目'});
  const down=new Event('pointerdown',{bubbles:true}); Object.assign(down,{pointerType:'touch',clientX:0,clientY:0}); fireEvent(projectButton,down);
  const menu=await screen.findByRole('dialog',{name:'移到分区'}); assert.ok(within(menu).getByText('测试项目'));
});
test('duplicate and revision failures preserve draft and authoritative assignments', async () => {
  setup(); await create('已有'); fireEvent.click(screen.getByRole('button',{name:'新建分区'})); const input=screen.getByRole('textbox',{name:'新分区名称'});
  fireEvent.change(input,{target:{value:'已有'}}); fireEvent.keyDown(input,{key:'Enter'}); await screen.findByRole('alert'); assert.equal(snapshot.sections.length,1); assert.equal((input as HTMLInputElement).value,'已有');
  vi.mocked(api.workspaceSections.update).mockImplementationOnce(async()=>{ snapshot={...snapshot,revision:20}; return new Response(JSON.stringify({message:'Workspace layout changed'}),{status:409}); });
  fireEvent.change(input,{target:{value:'保留草稿'}}); fireEvent.keyDown(input,{key:'Enter'}); await screen.findByText('Workspace layout changed'); assert.equal((input as HTMLInputElement).value,'保留草稿');
  fireEvent.keyDown(input,{key:'Enter'}); await waitFor(()=>assert.ok(snapshot.sections.some(row=>row.name==='保留草稿')));
});
test('double-click renames inline, menu deletes only classification and exposes mobile sorting', async () => {
  setup(); await create('原名'); const header=screen.getByRole('button',{name:/原名 0/}); fireEvent.doubleClick(header);
  const input=screen.getByRole('textbox',{name:'分区名称'}); fireEvent.change(input,{target:{value:'新名'}}); fireEvent.keyDown(input,{key:'Enter'}); await waitFor(()=>assert.equal(snapshot.sections[0].name,'新名'));
  fireEvent.click(screen.getByRole('button',{name:'分区操作：新名'})); assert.ok(screen.getByRole('menuitem',{name:'上移'})); assert.ok(screen.getByRole('menuitem',{name:'下移'}));
  fireEvent.click(screen.getByRole('menuitem',{name:/删除分区/})); await waitFor(()=>assert.equal(snapshot.sections.length,0)); assert.ok(await screen.findByText(/已删除分区，只取消归类/));
});
