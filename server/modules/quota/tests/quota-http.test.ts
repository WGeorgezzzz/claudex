import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { test } from 'node:test';

import { quotaFetch } from '../quota.http.js';

test('Claude metadata uses the configured CONNECT proxy without changing global agents or exposing its token to the proxy', async () => {
  const old = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  const globalAgent = https.globalAgent;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Unexpected direct request in proxy regression'); };
  let connected = false;
  const proxy = http.createServer();
  proxy.on('connect', (request, socket) => {
    connected = true; assert.equal(request.url, 'api.anthropic.com:443');
    assert.equal(request.headers.authorization, undefined);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address(); assert(address && typeof address !== 'string');
  delete process.env.https_proxy; delete process.env.NO_PROXY; delete process.env.no_proxy;
  // Windows environment names are case-insensitive; deleting lowercase after setting uppercase removes both.
  process.env.HTTPS_PROXY = `http://127.0.0.1:${address.port}`;
  try {
    await assert.rejects(quotaFetch('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: 'Bearer fake-credential' }, signal: AbortSignal.timeout(3000) }), { code: 'ERR_PROXY_TUNNEL' });
    assert(connected); assert.equal(https.globalAgent, globalAgent);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});
