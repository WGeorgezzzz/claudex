import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { UsersSettingsTab } from '@/modules/settings/tabs/UsersSettingsTab';
import { UserManagementTab } from '@/modules/settings/tabs/UserManagementTab';
const fixture=vi.hoisted(()=>({role:'member'}));
vi.mock('@/modules/auth',()=>({useAuth:()=>({user:{id:1,username:'test',role:fixture.role},logout:vi.fn()})}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock('@/modules/project-creation-wizard',()=>({FolderBrowserModal:()=>null}));
vi.mock('@/shared/api',()=>({readApiErrorMessage:()=>'',api:{auth:{users:vi.fn(async()=>new Response(JSON.stringify({users:[{id:2,username:'alice',role:'member',work_root:'D:/alice',allowed_folders:'["D:/shared"]',access_sso_email:'alice@example.com',is_active:1,created_at:'2026-10-23 10:00:00'}]})))}}}));
afterEach(cleanup);
test('the account tab only offers self password controls',()=>{
  fixture.role='member';render(<UsersSettingsTab/>);
  expect(screen.queryByText('users.create')).toBeNull();
  expect(screen.getByText('users.currentPassword')).toBeTruthy();
});
test('administrators see the user list with access details',async()=>{
  fixture.role='admin';render(<UserManagementTab/>);
  await waitFor(()=>expect(screen.getByText('alice@example.com')).toBeTruthy());
  expect(screen.getByText('D:/shared')).toBeTruthy();
  expect(screen.getByText('D:/alice')).toBeTruthy();
  expect(screen.getAllByText('users.create').length).toBe(1);
  expect(screen.getByText('users.delete')).toBeTruthy();
});
