const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

function validateQuota(input, now = Date.now()) {
  if (!input || input.sourceUrl !== 'https://wenclaude.com/app' || !Array.isArray(input.windows)
    || input.windows.length > 4 || Math.abs(now - Date.parse(input.checkedAt)) > 5 * 60000
    || !Number.isFinite(Date.parse(input.checkedAt))) throw Error('Invalid quota payload');
  const labels = new Set();
  const windows = input.windows.map(row => {
    if (!['5小时限制', '所有模型', 'Fable'].includes(row.label) || labels.has(row.label)
      || typeof row.usedPercent !== 'number' || !Number.isFinite(row.usedPercent) || row.usedPercent < 0 || row.usedPercent > 100
      || (row.resetLabel != null && (typeof row.resetLabel !== 'string' || row.resetLabel.length > 100))) throw Error('Invalid quota window');
    labels.add(row.label);
    return { label: row.label, usedPercent: row.usedPercent, remainingPercent: 100 - row.usedPercent, resetLabel: row.resetLabel || null };
  });
  if (!labels.has('5小时限制')) throw Error('Five-hour quota missing');
  return { version: 1, provider: 'claude', status: 'ok', source: 'chrome', sourceUrl: 'https://wenclaude.com/app',
    checkedAt: new Date(input.checkedAt).toISOString(), receivedAt: new Date(now).toISOString(), windows, note: '来自当前 Chrome 的 wenClaude 网页。' };
}

function readChromeQuota(directory, now = Date.now()) {
  try {
    const row = JSON.parse(fs.readFileSync(path.join(directory, 'chrome-wenclaude.json'), 'utf8'));
    const checked = Date.parse(row.checkedAt);
    if (!Number.isFinite(checked) || now - checked > 45 * 60000 || checked - now > 60000) return null;
    return { ...validateQuota(row, checked), receivedAt: row.receivedAt };
  } catch { return null; }
}

function createBridgeServer({ directory, token }) {
  if (typeof token !== 'string' || token.length < 32) throw Error('Invalid bridge token');
  fs.mkdirSync(directory, { recursive: true });
  const expected = Buffer.from(token);
  const server = http.createServer(async (request, response) => {
    const reply = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); };
    if (!/^127\.0\.0\.1:\d+$/.test(request.headers.host || '')) return reply(403, { error: 'Invalid host' });
    if (request.method === 'GET' && request.url === '/health') return reply(200, { service: 'gaci-quota-bridge', ready: true });
    if (request.method !== 'POST' || request.url !== '/quota/wenclaude') return reply(404, { error: 'Not found' });
    const actual = Buffer.from(String(request.headers['x-gaci-quota-token'] || ''));
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return reply(403, { error: 'Unauthorized source' });
    const origin = request.headers.origin;
    if (origin && !['https://wenclaude.com', 'chrome-extension://dhdgffkkebhmkfjojejmpbldmpobfkfo'].includes(origin)) return reply(403, { error: 'Invalid origin' });
    let size = 0, body = '';
    try {
      for await (const chunk of request) { size += chunk.length; if (size > 8192) { reply(413, { error: 'Payload too large' }); return; } body += chunk; }
      const row = validateQuota(JSON.parse(body));
      const temporary = path.join(directory, `chrome-quota-${crypto.randomUUID()}.tmp`);
      fs.writeFileSync(temporary, JSON.stringify(row, null, 2));
      fs.renameSync(temporary, path.join(directory, 'chrome-wenclaude.json'));
      reply(200, { received: true, checkedAt: row.checkedAt });
    } catch { reply(400, { error: 'Invalid quota data' }); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  return server;
}

module.exports = { validateQuota, readChromeQuota, createBridgeServer };
if (require.main === module) {
  const directory = process.env.CLAUDEX_USAGE_HOME || path.join(os.homedir(), '.cloudcli', 'provider-usage');
  if (process.argv.includes('--prepare')) {
    fs.mkdirSync(directory, { recursive: true });
    const configPath = path.join(directory, 'chrome-bridge.json');
    const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
      : { enabled: true, port: 3187, token: crypto.randomBytes(32).toString('hex') };
    if (typeof config.token !== 'string' || config.token.length < 32 || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw Error('Invalid saved bridge configuration');
    config.enabled = true;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    const template = fs.readFileSync(path.join(__dirname, 'wenclaude-quota.user.js'), 'utf8');
    const scriptPath = path.join(directory, 'wenclaude-quota.user.js');
    fs.writeFileSync(scriptPath, template.replace('__BRIDGE_PORT__', String(config.port)).replace('__BRIDGE_TOKEN__', config.token));
    console.log(JSON.stringify({ prepared: true, scriptPath, port: config.port }));
    process.exit(0);
  }
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'chrome-bridge.json'), 'utf8'));
  if (!config.enabled || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw Error('Invalid bridge configuration');
  const server = createBridgeServer({ directory, token: config.token });
  server.on('error', () => { console.error('Chrome quota bridge could not start.'); process.exitCode = 1; });
  server.listen(config.port, '127.0.0.1', () => console.log('Chrome quota bridge ready on loopback.'));
}
