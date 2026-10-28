import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { QuotaOverview } from '@/shared/types';
import { QuotaIndicator } from '@/modules/usage/QuotaIndicator';
const fixture = vi.hoisted(() => ({ data: null as QuotaOverview | null, error: '' }));
vi.mock('@/modules/usage/hooks/useQuota', () => ({ useQuota: () => ({ ...fixture, now: Date.parse('2026-10-28T01:00:00Z') }) }));
afterEach(() => { cleanup(); fixture.data = null; fixture.error = ''; });
const cache = (data: unknown) => ({ data, updatedAt: '2026-10-28T00:59:00Z', stale: false, error: null });
function setup() {
  fixture.data = { claude: cache({ windows: [{ label: '5h', percent: 18 }] }), pool: cache({ warnings: [], accounts: [{ windows: [{ label: '5h', percent: 2 }] }, { windows: [{ label: '5h', percent: 30 }] }] }), local: [{ provider: 'claude', status: 'unavailable', windows: [] }, { provider: 'codex', status: 'ok', windows: [{ label: '7 天', usedPercent: 6 }] }] } as unknown as QuotaOverview;
}
test('relay Claude survives unavailable local collector and Codex takes the maximum across the pool', () => {
  setup(); render(<QuotaIndicator onOpen={() => {}}/>);
  expect(screen.getByTestId('quota-indicator').textContent).toBe('Claude 5h 18% · Codex 5h 30%');
  expect(screen.queryByText('未连接')).toBeNull();
});
test('only a stale or failed segment dims and its reason stays in the tooltip', () => {
  setup(); fixture.data!.claude.stale = true; fixture.data!.claude.error = 'offline';
  render(<QuotaIndicator onOpen={() => {}}/>);
  expect(screen.getByTitle('读取失败（上次 1 分钟前）').className).toContain('opacity-60');
  expect(screen.getByTitle('1 分钟前').className).not.toContain('opacity-60');
  expect(screen.getByTestId('quota-indicator').textContent).toBe('Claude 5h 18% · Codex 5h 30%');
});
test('both missing sources give one settings link', () => {
  const open = vi.fn(); render(<QuotaIndicator onOpen={open}/>);
  fireEvent.click(screen.getByRole('button', { name: '用量未连接 · 点击设置' })); expect(open).toHaveBeenCalledOnce();
});
test('empty pool falls back to retained local Codex and preserves red pool warnings', () => {
  setup(); fixture.data!.pool!.data!.accounts = []; fixture.data!.pool!.data!.warnings = ['号池告警'];
  render(<QuotaIndicator onOpen={() => {}}/>);
  expect(screen.getByTestId('quota-indicator').textContent).toContain('Claude 5h 18% · Codex 7天 6%');
  expect(screen.getByText('号池告警').className).toContain('text-red');
});
