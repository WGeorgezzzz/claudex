const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createBridgeServer, readChromeQuota, validateQuota } = require('./chrome-bridge.cjs');
const token = 'test-only-quota-token-0123456789abcdef';
const payload = () => ({ sourceUrl: 'https://wenclaude.com/app', checkedAt: new Date().toISOString(), windows: [{ label: '5小时限制', usedPercent: 17, resetLabel: '今天 06:40' }] });

test('loopback bridge rejects unauthenticated writes and stores only validated quota fields', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexcode-quota-test-'));
  const server = createBridgeServer({ directory, token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/quota/wenclaude`;
  try {
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'X-GACI-Quota-Token': token, Origin: 'https://evil.example' }, body: JSON.stringify(payload()) })).status, 403);
    const input = { ...payload(), cookie: 'must-not-store', windows: [{ ...payload().windows[0], email: 'must-not-store' }] };
    assert.equal((await fetch(url, { method: 'POST', headers: { 'X-GACI-Quota-Token': token }, body: JSON.stringify(input) })).status, 200);
    const row = readChromeQuota(directory); assert.equal(row.windows[0].remainingPercent, 83);
    assert(!fs.readFileSync(path.join(directory, 'chrome-wenclaude.json'), 'utf8').includes('must-not-store'));
    assert.equal(readChromeQuota(directory, Date.now() + 46 * 60000), null);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'X-GACI-Quota-Token': token }, body: JSON.stringify({ ...payload(), windows: [{ label: '5小时限制', usedPercent: 900 }] }) })).status, 400);
    assert.equal(readChromeQuota(directory).windows[0].remainingPercent, 83, 'bad updates preserve the last valid sample');
  } finally {
    await new Promise(resolve => server.close(resolve));
    assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'nexcode-quota-test-'));
    fs.rmSync(directory, { recursive: true });
  }
});
test('quota freshness and required window are validated before persistence', () => {
  for (const input of [{ ...payload(), checkedAt: 'invalid' }, { ...payload(), checkedAt: new Date(Date.now() - 6 * 60000).toISOString() },
    { ...payload(), windows: [{ label: '所有模型', usedPercent: 10 }] }]) assert.throws(() => validateQuota(input));
});

test('userscript waits for fresh confirmation and reports no account identity', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<body><h6>官方额度 登录账号 masked@example.com</h6><h6>5小时限制</h6><p>重置时间 今天 06:40 已使用 17%</p><button>刷新额度</button><div id="toast">额度已刷新</div><h6>最近使用</h6></body>',
    { url: 'https://wenclaude.com/app', runScripts: 'outside-only' });
  const sent = []; let sync;
  Object.defineProperty(dom.window.document.body, 'innerText', { get() { return this.textContent; } });
  dom.window.GM_registerMenuCommand = (_label, fn) => { sync = fn; };
  dom.window.GM_xmlhttpRequest = request => { sent.push(JSON.parse(request.data)); request.onload({ status: 200 }); };
  dom.window.setInterval = () => 0;
  const timeout = dom.window.setTimeout.bind(dom.window);
  dom.window.setTimeout = (fn, ms) => ms === 3000 ? 0 : timeout(fn, ms === 25000 ? 20 : ms);
  dom.window.console.warn = () => {};
  dom.window.eval(fs.readFileSync(path.join(__dirname, 'wenclaude-quota.user.js'), 'utf8'));
  await sync(); assert.equal(sent.length, 0, 'an old success toast cannot count as a refresh');
  dom.window.document.querySelector('button').addEventListener('click', () => { dom.window.document.querySelector('#toast').textContent = '额度已刷新'; });
  await sync(); assert.equal(sent.length, 1); assert.equal(sent[0].windows[0].usedPercent, 17);
  assert(!JSON.stringify(sent).includes('example.com')); dom.window.close();
});
