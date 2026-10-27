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
const props=()=>({projects:[{projectId:'a',displayName:'Old name',fullPath:'/alpha'}],filteredProjects:[{projectId:'a',displayName:'Old name',fullPath:'/alpha'}],selectedProject:null,onProjectSelect:vi.fn(),onNewSession:vi.fn()} as unknown as SidebarProjectListProps);
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
