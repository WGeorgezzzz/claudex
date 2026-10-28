// One bounded run, invoked by the host scheduler. No credentials are sent to the reporter model.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const readline = require('node:readline');
const { readChromeQuota } = require('./chrome-bridge.cjs');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const state = process.env.CLAUDEX_USAGE_HOME || path.join(os.homedir(), '.cloudcli', 'provider-usage');
const sources = { claude: 'https://wenclaude.com/app', cursor: 'https://cursor.com/dashboard/usage' };
const now = () => new Date().toISOString();
const failure = (provider, status, note) => ({ provider, status, checkedAt: now(), sourceUrl: sources[provider], windows: [], note });

async function codex() {
  const child = spawn(process.execPath, [require.resolve('@openai/codex/bin/codex.js'), 'app-server'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, CODEX_HOME: process.env.CLAUDEX_QUOTA_CODEX_HOME || path.join(os.homedir(), '.codex')},
  });
  child.stderr.resume(); child.stdin.on('error', () => {});
  let closed=false;child.on('exit',()=>{closed=true;for(const callback of pending.values())callback({error:{message:'process exited'}});pending.clear();});
  const reader = readline.createInterface({ input: child.stdout });
  let sequence = 0; const pending = new Map();
  reader.on('line', line => { try { const row = JSON.parse(line); pending.get(row.id)?.(row); } catch {} });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    if(closed){reject(Error('Codex quota process exited'));return;}
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('Codex quota timeout')); }, 20000);
    pending.set(id, row => { clearTimeout(timer); pending.delete(id); row.error ? reject(Error('Codex quota unavailable: '+String(row.error.code??'')+' '+String(row.error.message||'').replace(/(?:sk-|eyJ)[A-Za-z0-9_.-]+/g,'[redacted]').slice(0,180))) : resolve(row.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    await call('initialize', { clientInfo: { name: 'claudex-usage', version: '1' }, capabilities: {} });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
    const result = await call('account/rateLimits/read');
    const buckets = result.rateLimitsByLimitId || { codex: result.rateLimits };
    const windows = [];
    for (const [name, bucket] of Object.entries(buckets)) for (const kind of ['primary', 'secondary']) {
      const w = bucket?.[kind];
      if (!w || !Number.isFinite(w.usedPercent)) continue;
      const minutes = w.windowDurationMins;
      const duration = minutes && minutes % 1440 === 0 ? `${minutes / 1440} 天` : minutes && minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes || '?'} 分钟`;
      windows.push({ label: `${bucket.limitName || name} · ${duration}`,
        usedPercent: w.usedPercent, remainingPercent: Math.max(0, 100 - w.usedPercent),
        resetsAt: Number.isFinite(w.resetsAt) ? new Date(w.resetsAt * 1000).toISOString() : null });
    }
    return { provider: 'codex', status: windows.length ? 'ok' : 'unavailable', checkedAt: now(), windows,
      sourceUrl: 'https://chatgpt.com/codex/settings/usage', note: windows.length ? 'Codex 登录账号实时额度' : '当前账号未返回套餐额度；API Key 账号可能不提供此数据。' };
  } finally { reader.close(); child.stdin.end(); if(process.platform==='win32'){await execute('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000}).catch(()=>{});}else child.kill(); }
}

function installation() {
  for (const drive of ['D:', 'C:', 'E:']) {
    const directory = path.join(drive, 'Program Files', 'WorkBuddyAI');
    if (fs.existsSync(path.join(directory, 'WorkBuddyAI.exe'))) return directory;
  }
  throw Error('WorkBuddy is not installed');
}

async function nativeWorkBuddy(args, timeout = 120000) {
  const install = installation();
  return execute(path.join(install, 'WorkBuddyAI.exe'), [path.join(root, 'scripts/workbuddy/local-login.cjs'), ...args], {
    cwd: state, windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDEX_WORKBUDDY_INSTALL: install, NODE_OPTIONS: '' },
  });
}

async function workbuddy() {
  const { stdout } = await nativeWorkBuddy(['--usage'], 25000);
  const result = JSON.parse(stdout);
  const windows = result.packages.map((row, i) => {
    const remaining = Number(row.remaining), total = Number(row.total);
    if (!Number.isFinite(remaining) || !Number.isFinite(total) || total < 0) throw Error('Invalid credit summary');
    return { label: `积分包 ${i + 1}`, remaining, total, unit: 'credits',
      remainingPercent: total > 0 ? 100 * remaining / total : null };
  });
  return { provider: 'workbuddy', status: 'ok', checkedAt: result.checkedAt, windows,
    sourceUrl: 'https://www.workbuddy.ai/profile/plans-usage', note: '客户端同源积分摘要；免费模型的 0 积分价格与账号剩余积分分别计算。' };
}

function parseClaude(text) {
  const windows = [];
  const heading = text.indexOf('官方额度');
  if (heading >= 0) text = text.slice(heading).split('最近使用')[0];
  const labels = ['5小时限制', '所有模型', 'Fable'];
  for (const label of labels) {
    const start = text.indexOf(label);
    if (start < 0) continue;
    const end = Math.min(start + label.length + 180, ...labels.map(other => text.indexOf(other, start + label.length)).filter(i => i >= 0));
    const part = text.slice(start + label.length, end);
    const used = part.match(/已使用\s*([\d.]+)\s*%/);
    if (!used) continue;
    const usedPercent = Number(used[1]);
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) continue;
    const reset = part.match(/重置时间\s*([\s\S]*?)已使用/);
    windows.push({ label, usedPercent, remainingPercent: 100 - usedPercent, resetLabel: reset?.[1].replace(/\s+/g, ' ').trim() || null });
  }
  if (!windows.some(w => w.label === '5小时限制')) return failure('claude', 'unavailable', 'wenClaude 网页未返回可核对的五小时额度。');
  return { provider: 'claude', status: 'ok', checkedAt: now(), sourceUrl: sources.claude, windows, note: '来自 wenClaude 网页的官方额度区域。' };
}

async function browserUsage(provider, login = false) {
  if (provider === 'claude' && !login && fs.existsSync(path.join(state, 'chrome-bridge.json'))) {
    return readChromeQuota(state) || failure('claude', 'unavailable', '未连接：本机接收端没有网页额度快照。请在当前 Chrome 的 Tampermonkey 安装 provider-usage/wenclaude-quota.user.js，并打开已登录的 wenClaude 仪表盘。');
  }
  const profile = path.join(state, 'browser-profile');
  if (!login && !fs.existsSync(path.join(profile, 'Default'))) return failure(provider, 'login_required', '请在专用浏览器登录一次，之后自动更新。');
  const { chromium } = require('playwright');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: !login,
    viewport: { width: 1280, height: 900 }, args: ['--no-first-run'] });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(sources[provider], { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (login) { await new Promise(resolve => context.once('close', resolve)); return; }
    // Wait for the actual quota or login surface; a navigation alone is never success.
    await page.getByText(provider === 'claude' ? /官方额度|登录账户|邮箱登录|登录账号|密码/ : /Included Usage|Usage|Sign in|Log in/).first().waitFor({ timeout: 20000 }).catch(() => {});
    if (provider === 'claude') {
      const refresh = page.getByRole('button', { name: '刷新额度', exact: true });
      if (await refresh.count()) {
        const response = page.waitForResponse(r => r.url().includes('/api/quota/refresh'), { timeout: 20000 });
        await refresh.click(); const r = await response;
        if (!r.ok()) throw Error('WenClaude refresh failed');
        await r.finished();
        await page.getByText('额度已刷新', { exact: true }).waitFor({ timeout: 10000 }).catch(() => {});
      }
      const text = await page.locator('body').innerText();
      if (!text.includes('官方额度') && /登录|login/i.test(text + page.url())) return failure(provider, 'login_required', 'wenClaude 登录已失效，请重新登录用量专用浏览器。');
      return parseClaude(text);
    }
    const text = await page.locator('body').innerText();
    if (/\/login|\/sign-in/.test(page.url()) || /Sign in to Cursor|Log in to Cursor/.test(text)) return failure(provider, 'login_required', '请在用量专用浏览器登录 Cursor。');
    // Do not reinterpret spending or token counts as remaining entitlement.
    const remaining = text.match(/(?:Remaining|剩余)\s*\$\s*([\d,.]+)/i);
    return remaining ? { provider, status: 'ok', checkedAt: now(), sourceUrl: sources[provider],
      windows: [{ label: '页面显示剩余额度', remaining: Number(remaining[1].replace(/,/g, '')), unit: 'USD' }] }
      : failure(provider, 'unavailable', 'Cursor 页面未提供可直接核对的剩余额度；未用消费金额推算。');
  } finally { await context.close().catch(() => {}); }
}

async function report(rows) {
  const product = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.workbuddy-ai/cache/acc-product-config-v3.json'), 'utf8'));
  const model = product.models?.find(row => row.id === 'deepseek-v4.1-flash');
  if (!model || !/^x0(?:\.0+)?(?:\s+credits)?$/i.test(String(model.credits))) throw Error('DeepSeek is not currently marked zero credits');
  const promotions = (product.modelPromotions || []).filter(p => p.modelIds?.includes(model.id) && p.discount?.factor === 0);
  if (promotions.length && !promotions.some(p => p.enabled && Date.now() >= Date.parse(p.schedule?.validFrom) && Date.now() < Date.parse(p.schedule?.validUntil))) throw Error('DeepSeek free promotion expired');
  const prompt = '核对以下软件用量快照。只根据提供的数值，用一句中文总结当前剩余额度和哪些软件需要登录或未提供数据。不要调用任何工具，不要猜测，不把免费价格当剩余额度，不换算货币。输出不超过 250 字。\n' + JSON.stringify(rows);
  const { stdout } = await nativeWorkBuddy(['-p', prompt, '--model', model.id, '--effort', 'low', '--max-turns', '1',
    '--output-format', 'stream-json', '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']);
  const lines = stdout.trim().split('\n');
  let result;
  for (const line of lines) { try { const row = JSON.parse(line); if (row.type === 'result' || row.result) result = row; } catch {} }
  if (result?.is_error || result?.subtype !== 'success' || typeof result.result !== 'string') throw Error('DeepSeek summary did not complete');
  return result.result.slice(0, 1200);
}

async function codexWithRetry(){
  try{return await codex();}catch{try{const row=await codex();return {...row,note:row.note+'（首次读取失败，已重试）'};}catch(error){return failure('codex','unavailable','Codex 原生额度接口失败；已重试，保留上次成功值。'+String(error.message).slice(0,240));}}
}
async function main() {
  fs.mkdirSync(state, { recursive: true });
  const lock = path.join(state, 'run.lock');
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); alive = true; } catch {} }
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (alive || age < 10 * 60000) { console.log(JSON.stringify({ skipped: 'run_in_progress' })); return; }
    fs.unlinkSync(lock);
  }
  const fd = fs.openSync(lock, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);
  try {
    const login = process.argv.indexOf('--login');
    if (login >= 0) { const provider = process.argv[login + 1]; if (!sources[provider]) throw Error('Invalid login source'); await browserUsage(provider, true); return; }
    const rows = [];
    for (const [provider, read] of [['codex', codexWithRetry], ['workbuddy', workbuddy], ['claude', () => browserUsage('claude')], ['cursor', () => browserUsage('cursor')]]) {
      try { rows.push(await read()); } catch { rows.push(failure(provider, 'unavailable', '本次读取失败；未将失败记为零额度。')); }
    }
    rows.push(failure('opencode', 'unsupported', 'OpenCode 使用多个上游账号，没有统一套餐额度接口。'));
    const previous = (() => { try { return JSON.parse(fs.readFileSync(path.join(state, 'snapshot.json'), 'utf8')); } catch { return null; } })();
    for (const row of rows) if (row.status !== 'ok') {
      const old = previous?.providers?.find(p => p.provider === row.provider);
      const last = old?.status === 'ok' ? { checkedAt: old.checkedAt, windows: old.windows } : old?.lastSuccess;
      if (last) row.lastSuccess = last;
    }
    let reporter;
    try { reporter = { provider: 'workbuddy', model: 'deepseek-v4.1-flash', status: 'ok', summary: await report(rows) }; }
    catch { reporter = { provider: 'workbuddy', model: 'deepseek-v4.1-flash', status: 'error', summary: 'DeepSeek 本次核对未完成，下面保留各来源的独立读取结果。' }; }
    const snapshot = { version: 1, updatedAt: now(), nextRunAt: new Date(Date.now() + 30 * 60000).toISOString(), intervalMinutes: 30, reporter, providers: rows };
    const temporary = path.join(state, `snapshot-${process.pid}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2)); fs.renameSync(temporary, path.join(state, 'snapshot.json'));
    fs.appendFileSync(path.join(state, 'runs.jsonl'), JSON.stringify({ updatedAt: snapshot.updatedAt, reporter: reporter.status, sources: rows.map(r => ({ provider: r.provider, status: r.status })) }) + '\n');
    console.log(JSON.stringify({ updatedAt: snapshot.updatedAt, reporter: reporter.status, sources: rows.map(r => ({ provider: r.provider, status: r.status })) }));
  } finally { fs.unlinkSync(lock); }
}

module.exports = { parseClaude, codex:codexWithRetry };
if (require.main === module) main().catch(() => { console.error('Usage monitor failed. Previous snapshot is preserved.'); process.exitCode = 1; });
