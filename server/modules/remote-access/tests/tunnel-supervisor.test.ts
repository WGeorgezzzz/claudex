import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { TunnelSupervisor } from '../tunnel-supervisor.js';

test('tunnel state machine parses chunked URL, reconnects, changes address and stops without resurrection', async () => {
  const children: Array<EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; killed: boolean; kill(): void }> = [];
  const addresses: string[] = [];
  const supervisor = new TunnelSupervisor({ retryMs: 10, onAddress: url => addresses.push(url), spawn: ((_cmd, _args, options) => {
    assert.equal(options?.windowsHide, true);
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, kill() { this.killed = true; } });
    children.push(child); return child;
  }) as typeof spawn });
  supervisor.start('cloudflared', []); assert.equal(supervisor.state.phase, 'connecting');
  children[0].stderr.emit('data', Buffer.from('https://first.trycloud'));
  children[0].stderr.emit('data', Buffer.from('flare.com\n'));
  assert.equal(supervisor.state.phase, 'running'); assert.equal(supervisor.state.url, 'https://first.trycloudflare.com');
  children[0].emit('close', 1); children[0].emit('error', Error('late error'));
  assert.equal(supervisor.state.phase, 'reconnecting');
  await new Promise(r => setTimeout(r, 30)); assert.equal(children.length, 2);
  children[1].stdout.emit('data', Buffer.from('Hosting at https://second.use.devtunnels.ms:443/, https://second-443.use.devtunnels.ms/; inspect https://second-443-inspect.use.devtunnels.ms/'));
  assert.equal(supervisor.state.phase, 'running'); assert.equal(addresses.length, 2);
  assert.equal(supervisor.state.url, 'https://second-443.use.devtunnels.ms');
  supervisor.stop(); children[1].emit('close', 0);
  await new Promise(r => setTimeout(r, 30)); assert.equal(children.length, 2);
  assert.equal(supervisor.state.phase, 'stopped'); assert.equal(children[1].killed, true);
  supervisor.start('tailscale', []); children[2].stdout.emit('data', Buffer.from('https://test.tail.ts.net:8443/'));
  assert.equal(supervisor.state.url, 'https://test.tail.ts.net:8443'); supervisor.stop();
});
