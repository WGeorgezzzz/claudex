import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

import { openLocalFile } from '@/shared/localPath';

const bridge = window as unknown as {
  cloudcliDesktopNotifications?: {
    openLocalPath?: ReturnType<typeof vi.fn>;
    getCapabilities?: ReturnType<typeof vi.fn>;
  };
  cloudcliDesktop?: {
    openLocalPath?: ReturnType<typeof vi.fn>;
    getCapabilities?: ReturnType<typeof vi.fn>;
  };
};

afterEach(() => {
  delete bridge.cloudcliDesktopNotifications;
  delete bridge.cloudcliDesktop;
  vi.restoreAllMocks();
});

test('selects a legacy bridge when the notification bridge has no file method', async () => {
  const open = vi.fn().mockResolvedValue({ path: 'D:/报告.md' });
  bridge.cloudcliDesktopNotifications = { getCapabilities: vi.fn().mockResolvedValue({ localPaths: false }) };
  bridge.cloudcliDesktop = { openLocalPath: open, getCapabilities: vi.fn().mockResolvedValue({ localPaths: true }) };

  await openLocalFile('D:/报告.md');

  assert.deepEqual(open.mock.calls, [['D:/报告.md']]);
});

test('tries the action when an old shell rejects capability probing', async () => {
  const open = vi.fn().mockResolvedValue({});
  bridge.cloudcliDesktopNotifications = {
    openLocalPath: open,
    getCapabilities: vi.fn().mockRejectedValue(new Error('No handler registered for capabilities')),
  };

  await openLocalFile('D:/report.pdf');

  assert.deepEqual(open.mock.calls, [['D:/report.pdf']]);
});
