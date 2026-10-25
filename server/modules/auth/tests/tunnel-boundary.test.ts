import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { isLocalRequest, requiresRemoteLogin, validateAccessBoundary } from '../access-boundary.js';
import { createManagedTunnelIngress, isManagedTunnelRequest } from '../managed-tunnel-ingress.js';

test('all known forwarding headers turn a loopback host into remote access, including empty header values', () => {
  const request = (headers: Record<string, string>) => ({ headers: { host: '127.0.0.1:59999', ...headers }, socket: { remoteAddress: '127.0.0.1' } }) as IncomingMessage;
  assert.equal(isLocalRequest(request({})), true);
  for (const key of ['x-forwarded-for','forwarded','x-forwarded-host','x-forwarded-proto','cf-connecting-ip','tailscale-user-login','x-tunnel-id','x-tunnel-authorization','x-devtunnel-id','x-nexagent-managed-tunnel']) {
    assert.equal(isLocalRequest(request({ [key]: 'value' })), false, key);
    assert.equal(requiresRemoteLogin(request({ [key]: '' })), true, key);
  }
  assert.equal(isManagedTunnelRequest(request({ 'x-nexagent-managed-tunnel': '0'.repeat(64) })), false);
});
test('dedicated ingress marks real HTTP even with no forwarded headers; a forged marker cannot bypass custom-domain Access', async () => {
  const old = process.env.CLAUDEX_PRIVATE_GATE;
  process.env.CLAUDEX_PRIVATE_GATE = '1';
  const server = http.createServer((req, res) => { void validateAccessBoundary(req).then(accepted => res.end(JSON.stringify({ local: isLocalRequest(req), managed: isManagedTunnelRequest(req), accepted }))); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const ingress = await createManagedTunnelIngress((server.address() as AddressInfo).port);
  try {
    const received = await (await fetch(`http://127.0.0.1:${ingress.port}/`)).json();
    assert.deepEqual(received, { local: false, managed: true, accepted: true });
    const forged = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, { headers: { 'x-nexagent-managed-tunnel': '0'.repeat(64) } })).json();
    assert.deepEqual(forged, { local: false, managed: false, accepted: false });
    const wrongOrigin = await (await fetch(`http://127.0.0.1:${ingress.port}/`, { headers: { origin: 'https://evil.example' } })).json();
    assert.equal((wrongOrigin as {accepted: boolean}).accepted, false);
  } finally { ingress.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); if (old === undefined) delete process.env.CLAUDEX_PRIVATE_GATE; else process.env.CLAUDEX_PRIVATE_GATE = old; }
});
