import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { authRoutes } from '../auth.module.js';
import { createManagedTunnelIngress } from '../managed-tunnel-ingress.js';
import { installAuthorizationFixture } from '@/test-support/authorization-fixture.js';

installAuthorizationFixture();
test('managed ingress login limit cannot be bypassed with forged CF or forwarded IP headers', async () => {
  const app = express(); app.use(express.json()); app.use('/api/auth', authRoutes);
  app.use((error: {statusCode?: number}, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.statusCode ?? 500).json({error:'Rejected'}); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  const ingress = await createManagedTunnelIngress((server.address() as AddressInfo).port);
  try {
    for (let i = 0; i < 11; i++) {
      const r = await fetch(`http://127.0.0.1:${ingress.port}/api/auth/login`, {method:'POST',headers:{'content-type':'application/json','cf-connecting-ip':`198.51.100.${i+1}`,'x-forwarded-for':`203.0.113.${i+1}`},body:JSON.stringify({username:'nonexistent-fixture-user',password:'wrong'})});
      assert.equal(r.status, i === 10 ? 429 : 401);
    }
  } finally { ingress.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
