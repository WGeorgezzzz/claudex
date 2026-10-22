import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { api } from '@/shared/api';
import type { SidebarProjectListProps, WorkspaceSectionsSnapshot } from '@/shared/types';
import { WorkspaceSections } from '@/modules/sidebar/WorkspaceSections';

vi.mock('@/shared/api',()=>({api:{workspaceSections:{list:vi.fn(),update:vi.fn()},sessionBridge:{list:vi.fn()}},readApiErrorMessage:()=> 'Layout changed'}));
vi.mock('@/modules/sidebar/SidebarProjectList',()=>({default:({filteredProjects,getProjectSessions}:SidebarProjectListProps)=><div>{filteredProjects.map(project=><span key={project.projectId}>Project:{project.projectId} Chats:{getProjectSessions(project).map(row=>row.id).join(',')}</span>)}</div>}));
const project={projectId:'p1',displayName:'Research project',fullPath:'/research'};
const props={projects:[project],filteredProjects:[project],getProjectSessions:()=>[{id:'s1'},{id:'s2'}],activeSessions:new Set(),selectedSession:null} as unknown as SidebarProjectListProps;
let snapshot:WorkspaceSectionsSnapshot;
const response=(data:unknown)=>new Response(JSON.stringify({data}));
beforeEach(()=>{
  vi.clearAllMocks();snapshot={revision:1,sections:[{id:'a',name:'Research',collapsed:false}],assignments:[{kind:'project',targetId:'p1',sectionId:'a'},{kind:'session',targetId:'s1',sectionId:'a'}],sessionItems:[{sessionId:'s1',title:'Independent chat',provider:'claude',projectPath:'/research',projectId:'p1'}]};
  vi.mocked(api.workspaceSections.list).mockImplementation(async()=>response(snapshot));
  vi.mocked(api.workspaceSections.update).mockImplementation(async input=>{snapshot={...snapshot,revision:snapshot.revision+1,sections:input.action==='collapse'?snapshot.sections.map(row=>({...row,collapsed:Boolean(input.collapsed)})):snapshot.sections};return response(snapshot);});
});
test('sections place projects and standalone chats without duplicating assigned chats inside project lists',async()=>{
  const select=vi.fn();render(<WorkspaceSections projectListProps={props} onSelect={select}/>);
  const link=await screen.findByRole('link',{name:/Independent chat/});
  assert.ok(screen.getByText('Project:p1 Chats:s2'));fireEvent.click(link);assert.deepEqual(select.mock.calls,[['p1','s1','claude']]);
  fireEvent.click(screen.getByRole('button',{name:/Research 2/}));await waitFor(()=>assert.equal(screen.queryAllByRole('link').length,0));
  assert.deepEqual(vi.mocked(api.workspaceSections.update).mock.calls[0][0],{action:'collapse',id:'a',collapsed:true,revision:1});
});
test('assignment controls use stable IDs and refresh instead of overwriting revision conflicts',async()=>{
  vi.mocked(api.workspaceSections.update).mockImplementation(async()=>{snapshot={...snapshot,revision:2};return new Response('{}',{status:409});});
  render(<WorkspaceSections projectListProps={props} onSelect={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button',{name:/Manage sections|管理分区/}));
  fireEvent.change(screen.getByRole('combobox',{name:/Section for Research project|Research project 所在分区/}),{target:{value:''}});
  await screen.findByRole('alert');
  assert.deepEqual(vi.mocked(api.workspaceSections.update).mock.calls[0][0],{action:'assign',kind:'project',targetId:'p1',sectionId:null,revision:1});
  await waitFor(()=>assert.ok(vi.mocked(api.workspaceSections.list).mock.calls.length>=2));
});
