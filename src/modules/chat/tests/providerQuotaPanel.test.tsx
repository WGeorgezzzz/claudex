import assert from 'node:assert/strict';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';
import { api } from '@/shared/api';
import { ProviderQuotaPanel } from '@/modules/chat/modals/ProviderQuotaPanel';

afterEach(() => vi.restoreAllMocks());
test('the model page shows zero remaining as a real result and keeps login failure distinct', async () => {
  vi.spyOn(api.providers, 'usageSnapshot').mockResolvedValue(new Response(JSON.stringify({ data: {
    updatedAt: '2026-10-24T00:00:00Z', stale: false, intervalMinutes: 30, providers: [
      { provider: 'codex', status: 'ok', windows: [{ label: '5 小时', remainingPercent: 0 }] },
      { provider: 'claude', status: 'login_required', windows: [], note: 'Login needed' },
    ],
  } })));
  const login = vi.spyOn(api.providers, 'openUsageLogin').mockResolvedValue(new Response('{}'));
  render(<ProviderQuotaPanel />);
  await screen.findByText('5 小时：0%');
  assert(screen.getByText('需要登录'));
  fireEvent.click(screen.getByText('打开专用登录窗口'));
  await waitFor(() => assert.equal(login.mock.calls[0][0], 'claude'));
});
test('an administrator-only snapshot does not show host quotas to an unauthorized user', async () => {
  vi.spyOn(api.providers, 'usageSnapshot').mockResolvedValue(new Response('{}', { status: 403 }));
  render(<ProviderQuotaPanel />);
  await screen.findByText('用量属于本机管理员账号。');
  assert.equal(screen.queryByRole('table'), null);
});
test('failed collection labels retained values as historical rather than current remaining quota', async () => {
  vi.spyOn(api.providers, 'usageSnapshot').mockResolvedValue(new Response(JSON.stringify({ data: {
    updatedAt: '2026-10-24T00:00:00Z', stale: true, intervalMinutes: 30, providers: [
      { provider: 'claude', status: 'unavailable', windows: [], lastSuccess: { checkedAt: '2026-10-23T23:00:00Z', windows: [{ label: '5小时', remainingPercent: 20 }] } },
    ],
  } })));
  render(<ProviderQuotaPanel />);
  await screen.findByText('读取未成功');
  assert(screen.getByText(/历史值/)); assert(screen.getByText(/数据已过期/));
});
