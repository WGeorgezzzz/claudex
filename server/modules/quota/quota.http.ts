import { Agent, request } from 'node:https';
import type { AgentOptions } from 'node:https';

/** Quota service uses a dedicated native proxy agent for Claude metadata; other process traffic is unaffected. */
export async function quotaFetch(url: string, init: RequestInit): Promise<Response> {
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY;
  if (!proxy || new URL(url).origin !== 'https://api.anthropic.com') return fetch(url, init);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 21 || major === 24 && minor < 5) throw new Error('Quota proxy requires Node 22.21+ or 24.5+');
  // proxyEnv honors HTTPS_PROXY/NO_PROXY without changing global agents or model transports.
  const agent = new Agent({ proxyEnv: process.env } as AgentOptions);
  try {
    return await new Promise<Response>((resolve, reject) => {
      const req = request(url, { method: 'GET', agent, signal: init.signal ?? undefined, headers: Object.fromEntries(new Headers(init.headers).entries()) }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 2 * 1024 * 1024) response.destroy(new Error('Quota response too large')); else chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => resolve(new Response(Buffer.concat(chunks).toString('utf8'), { status: response.statusCode || 502 })));
      });
      req.on('error', reject); req.end();
    });
  } finally { agent.destroy(); }
}
