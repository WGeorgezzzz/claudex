import { installAuthorizationFixture, testUserId } from '@/test-support/authorization-fixture.js';
import { withUserContext } from '@/modules/auth/index.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { browserUseService } from '@/modules/browser-use/browser-use.service.js';

installAuthorizationFixture();

test('browser monitor list starts empty without agent sessions', async () => {
  const sessions = await withUserContext(testUserId(), () => browserUseService.listSessions());

  assert.deepEqual(sessions, []);
});
