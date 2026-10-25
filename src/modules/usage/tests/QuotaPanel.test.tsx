import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QuotaPanel } from '@/modules/usage/QuotaPanel';
import { QuotaIndicator } from '@/modules/usage/QuotaIndicator';

const fixture = vi.hoisted(() => ({ warnings: [] as string[] }));
vi.mock('@/modules/usage/hooks/useQuota', () => ({ useQuota: () => ({
  data: { claude: { data: { windows: [], extraUsageEnabled: false }, stale: false, updatedAt: '2026-10-26T02:00:00Z' },
    key: { data: { mode: 'not_relay' } }, pool: { data: { thresholds: { fiveHour: 0, sevenDay: 0.99 }, warnings: fixture.warnings,
      accounts: [{ id: 1, name: 'qq', schedulable: true, status: 'active', windows: [],
        autoPause: { fiveHour: { disabled: true, threshold: 0 }, sevenDay: { disabled: false, threshold: 0.99 } } }] },
      stale: false, updatedAt: '2026-10-26T02:00:00Z' } },
  busy: false, error: null, now: Date.parse('2026-10-26T02:00:00Z'), refresh: vi.fn(),
}) }));

afterEach(() => { cleanup(); fixture.warnings = []; });
describe('quota threshold display', () => {
  it('explains unset five-hour quota and displays account overrides without threshold alerts', () => {
    render(<QuotaPanel />);
    expect(screen.getByText(/未设置（账号无 5 小时限额）/)).toBeTruthy();
    expect(screen.getByText(/账号自动暂停配置.*5h.*已禁用.*0.*7 天.*0\.99/)).toBeTruthy();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });
  it('keeps the sidebar neutral for the accepted configuration and repeats real warnings', () => {
    const view = render(<QuotaIndicator onOpen={() => {}} />);
    expect(screen.getByTestId('quota-indicator').className).not.toContain('text-red-700');
    fixture.warnings = ['账号 qq 点数被消耗 0.1'];
    view.rerender(<QuotaIndicator onOpen={() => {}} />);
    expect(screen.getByText('账号 qq 点数被消耗 0.1')).toBeTruthy();
    expect(screen.getByTestId('quota-indicator').className).toContain('text-red-700');
  });
});
