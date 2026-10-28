import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import { api } from '@/shared/api';
import type { ProjectOrganizationSnapshot, SidebarProjectListProps } from '@/shared/types';
import { ProjectOrganization } from '@/modules/sidebar/ProjectOrganization';

vi.mock('@/shared/api',()=>({api:{projectOrganization:{list:vi.fn(),update:vi.fn()}},readApiErrorMessage:()=> 'Organization changed'}));
vi.mock('@/modules/sidebar/SidebarSessionItem',()=>({default:()=>null}));
vi.mock('@/modules/sidebar/SidebarProjectList',()=>({default:()=>null}));
let snapshot:ProjectOrganizationSnapshot;
const response=(data:unknown)=>new Response(JSON.stringify({data}));
beforeEach(()=>{
  vi.clearAllMocks();snapshot={revision:1,mode:'project',projects:[{id:'a',name:'Alpha',path:'/alpha',rootPaths:['/alpha','/extra'],collapsed:false}],sessions:[],threadOrders:{}};
  vi.mocked(api.projectOrganization.list).mockImplementation(async()=>response(snapshot));
  vi.mocked(api.projectOrganization.update).mockImplementation(async input=>{snapshot={...snapshot,revision:snapshot.revision+1,projects:snapshot.projects.map(p=>({...p,collapsed:typeof input.collapsed==='boolean'?input.collapsed:p.collapsed}))};return response(snapshot);});
});
const props=()=>({projects:[{projectId:'a',displayName:'Old name',fullPath:'/alpha'}],filteredProjects:[{projectId:'a',displayName:'Old name',fullPath:'/alpha'}],selectedProject:null,onProjectSelect:vi.fn(),onNewSession:vi.fn(),isProjectStarred:()=>false} as unknown as SidebarProjectListProps);
test('project header selects the current project and new conversations use its stable physical cwd',async()=>{
  const callbacks=props();render(<ProjectOrganization props={callbacks}/>);
  fireEvent.click(await screen.findByRole('button',{name:'展开项目：Alpha'}));
  expect(callbacks.onProjectSelect).toHaveBeenCalledWith(expect.objectContaining({projectId:'a',displayName:'Alpha',fullPath:'/alpha'}));
  await waitFor(()=>expect(screen.getByRole('button',{name:'展开项目：Alpha'}).getAttribute('aria-expanded')).toBe('false'));
  fireEvent.click(screen.getByRole('button',{name:'新建项目对话：Alpha'}));
  expect(callbacks.onNewSession).toHaveBeenCalledWith(expect.objectContaining({projectId:'a',fullPath:'/alpha'}));
});
test('a stale project write is shown and refreshed instead of silently overwriting another client',async()=>{
  vi.mocked(api.projectOrganization.update).mockResolvedValue(new Response('{}',{status:409}));
  render(<ProjectOrganization props={props()}/>);fireEvent.click(await screen.findByRole('button',{name:'展开项目：Alpha'}));
  expect((await screen.findByRole('alert')).textContent).toContain('Organization changed');
  await waitFor(()=>expect(api.projectOrganization.list).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('button',{name:'展开项目：Alpha'}).getAttribute('aria-expanded')).toBe('true');
});

test('project tools are available through one menu while count and new conversation remain visible',async()=>{
  render(<ProjectOrganization props={props()}/>);
  await screen.findByRole('button',{name:'展开项目：Alpha'});
  expect(screen.queryByRole('button',{name:'项目设置：Alpha'})).toBeNull();
  expect(screen.queryByRole('button',{name:'上移项目：Alpha'})).toBeNull();
  expect(screen.getByRole('button',{name:'新建项目对话：Alpha'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'项目操作：Alpha'}));
  expect(screen.getByRole('menuitem',{name:'上移项目：Alpha'}).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('menuitem',{name:'项目设置：Alpha'}));
  expect(await screen.findByRole('textbox',{name:'项目名称'})).toBeTruthy();
});

test('search modes retain the session ownership editor without duplicating project navigation',async()=>{
  snapshot.sessions=[{id:'s1',title:'Session one',provider:'claude',sourceProjectId:'a',projectId:'a',cwd:'/alpha',roots:['/alpha'],updatedAt:'2026-10-27T00:00:00Z'}];
  render(<ProjectOrganization props={props()} editorOnly/>);
  await waitFor(()=>expect(api.projectOrganization.list).toHaveBeenCalled());
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(screen.queryByRole('button',{name:'展开项目：Alpha'})).toBeNull();
  window.dispatchEvent(new CustomEvent('sidebar:session-organization',{detail:'s1'}));
  expect(await screen.findByRole('combobox',{name:'归属项目'})).toBeTruthy();
});

test('time and name orders load all conversations and search beyond the first page',async()=>{
  snapshot.mode='flat';snapshot.sessions=Array.from({length:205},(_,i)=>({id:'s'+i,title:i===0?'Hidden needle':'Session '+i,provider:'claude',sourceProjectId:'a',projectId:'a',cwd:'/alpha',roots:['/alpha'],updatedAt:new Date(Date.UTC(2026,9,1)+i*60000).toISOString()}));
  const callbacks={...props(),activeSessions:new Set<string>(),backgroundSessionIds:new Set<string>(),attentionSessionIds:new Set<string>()};
  const view=render(<ProjectOrganization props={callbacks}/>);
  await screen.findByRole('button',{name:'加载更多（100/205）'});
  expect(view.container.querySelector('[data-organization-session]')?.getAttribute('data-organization-session')).toBe('s204');
  fireEvent.click(screen.getByRole('button',{name:'加载更多（100/205）'}));
  fireEvent.click(screen.getByRole('button',{name:'加载更多（200/205）'}));
  expect(view.container.querySelectorAll('[data-organization-session]')).toHaveLength(205);
  view.rerender(<ProjectOrganization props={callbacks} searchQuery="Hidden needle"/>);
  expect(view.container.querySelectorAll('[data-organization-session]')).toHaveLength(1);
  expect(view.container.querySelector('[data-organization-session]')?.getAttribute('data-organization-session')).toBe('s0');
  fireEvent.change(screen.getByRole('combobox',{name:'侧栏显示模式'}),{target:{value:'name'}});
  await waitFor(()=>expect(api.projectOrganization.update).toHaveBeenCalledWith(expect.objectContaining({action:'mode',mode:'name'})));
});
