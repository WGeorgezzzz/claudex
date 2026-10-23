import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { UsersSettingsTab } from '@/modules/settings/tabs/UsersSettingsTab';
const fixture=vi.hoisted(()=>({role:'member'}));
vi.mock('@/modules/auth',()=>({useAuth:()=>({user:{username:'test',role:fixture.role},logout:vi.fn()})}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
vi.mock('@/shared/api',()=>({readApiErrorMessage:()=>'',api:{auth:{users:vi.fn(async()=>new Response(JSON.stringify({users:[{id:2,username:'alice',role:'member',work_root:'D:/alice',allowed_folders:'["D:/shared"]',access_sso_email:'alice@example.com',is_active:1}]})))}}}));
afterEach(cleanup);
test('members only see self password controls',()=>{
  fixture.role='member';render(<UsersSettingsTab/>);
  expect(screen.queryByText('users.create')).toBeNull();
  expect(screen.getByText('users.currentPassword')).toBeTruthy();
});
test('administrators see creation and loaded access controls',async()=>{
  fixture.role='admin';render(<UsersSettingsTab/>);
  await waitFor(()=>expect(screen.getByDisplayValue('alice@example.com')).toBeTruthy());
  expect(screen.getByDisplayValue('D:/shared')).toBeTruthy();
  expect(screen.getAllByText('users.create').length).toBe(2);
});
