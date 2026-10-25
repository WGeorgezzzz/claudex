import http from 'node:http';
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const capability = randomBytes(32).toString('hex');
const header = 'x-nexagent-managed-tunnel';

/** Access boundaries accept this process-local capability only from the dedicated tunnel ingress proxy. */
export function isManagedTunnelRequest(req: IncomingMessage): boolean {
  const value = req.headers[header];
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
    && typeof value === 'string' && value.length === capability.length
    && timingSafeEqual(Buffer.from(value), Buffer.from(capability));
}

/** Remote-access owns this loopback proxy, which marks HTTP and WebSocket traffic even if a tunnel strips every forwarding header. */
export async function createManagedTunnelIngress(targetPort: number, ingressPort = 0, onIngress?: (req: IncomingMessage) => void) {
  const server = http.createServer((req, res) => {
    onIngress?.(req);
    const upstream = http.request({ hostname: '127.0.0.1', port: targetPort, path: req.url, method: req.method,
      headers: { ...req.headers, [header]: capability } }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end('Nexagent unavailable'); });
    req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
  });
  const sockets = new Set<net.Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      const headers = { ...req.headers, [header]: capability };
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(ingressPort, '127.0.0.1', resolve); });
  return { port: (server.address() as net.AddressInfo).port,
    close: () => { for (const socket of sockets) socket.destroy(); server.close(); } };
}
