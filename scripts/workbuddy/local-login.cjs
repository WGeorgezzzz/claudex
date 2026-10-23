// Executed by the installed WorkBuddy Electron runtime, never by the web renderer.
// Credentials are decoded in memory and passed only to the official bundled CLI.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

async function main() {
  const install = process.env.CLAUDEX_WORKBUDDY_INSTALL;
  const productPath = path.join(install, 'resources/app.asar.unpacked/cli/product.json');
  const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
  const endpoint = new URL(product.endpoint);
  if (endpoint.protocol !== 'https:' || !['www.workbuddy.ai', 'www.workbuddy.cn', 'copilot.tencent.com'].includes(endpoint.hostname)) {
    throw new Error('Unsupported WorkBuddy endpoint');
  }
  const authId = product.authentication?.id;
  if (!/^[a-z0-9-]+$/i.test(authId || '')) throw new Error('Invalid WorkBuddy authentication profile');
  const authPath = path.join(process.env.LOCALAPPDATA, 'CodeBuddyExtension/Data/Public/auth', authId + '.info');
  const session = JSON.parse(fs.readFileSync(authPath, 'utf8').replace(/^\uFEFF/, ''));
  let key;
  let keyId;
  const text = value => {
    const valueBytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4); length.writeUInt32BE(valueBytes.length);
    return Buffer.concat([length, valueBytes]);
  };
  const decode = value => {
    if (typeof value === 'string') return value;
    if (value?.$wbEncrypted !== 1 || value.scheme) throw new Error('Unsupported WorkBuddy credential format');
    if (!key) {
      const local = JSON.parse(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet());
      if (local.version !== 1 || typeof local.atRestSecretKey !== 'string') throw new Error('Unsupported WorkBuddy storage');
      key = crypto.createHash('sha256').update(local.atRestSecretKey, 'utf8').digest();
      keyId = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
    }
    const envelope = JSON.parse(Buffer.from(value.envelope, 'base64').toString('utf8'));
    if (envelope.keyId !== keyId || envelope.suite !== 1) throw new Error('WorkBuddy credential version mismatch');
    const suite = Buffer.alloc(4); suite.writeUInt32BE(1);
    const aad = Buffer.concat([Buffer.from('WB-AAD\0\x01'), text('WBEV1'), text('sym-v1'), suite, text(keyId), Buffer.from([2, 0, 0])]);
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
    cipher.setAAD(aad); cipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
    return Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, 'base64')), cipher.final()]).toString('utf8');
  };
  const token = decode(session.auth?.accessToken);
  if (!token || /\s/.test(token)) throw new Error('Invalid WorkBuddy login');
  const expiresAt = Number(session.auth?.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60000) {
    throw new Error('WorkBuddy login expired. Open WorkBuddy and sign in again.');
  }
  if (process.argv[2] === '--status') {
    process.stdout.write(JSON.stringify({ authenticated: true, expiresAt, product: product.productName, endpoint: endpoint.origin }));
    return;
  }
  if (process.argv[2] === '--usage') {
    // Read the same resource summary used by the installed desktop billing page.
    // Return quota fields only; neither account identifiers nor credentials enter stdout.
    const response = await fetch(endpoint.origin + '/billing/meter/get-user-resource-summary', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
        'X-User-Id': String(session.account?.uid || ''), 'X-Domain': String(session.auth?.domain || ''),
        'X-Product': product.deploymentType || 'SaaS', 'Accept-Language': 'zh' }, body: '{}',
    });
    if (!response.ok) throw new Error('Usage unavailable');
    const body = await response.json();
    if (!Array.isArray(body.data?.Packages)) throw new Error('Usage schema unavailable');
    process.stdout.write(JSON.stringify({ checkedAt: new Date().toISOString(), packages: body.data.Packages.map(row => ({
      name: row.PackageCode, total: row.CycleTotalCapacity, remaining: row.CycleRemainCapacity, used: row.CycleUsedCapacity,
    })) }));
    return;
  }
  for (const name of Object.keys(process.env)) {
    if (/^(https?|all)_proxy$/i.test(name) || /^(ANTHROPIC_|CLAUDE_|ACC_PRODUCT_CONFIG|CODEBUDDY_(AUTH_TOKEN|API_KEY|BASE_URL|CUSTOM_HEADERS))/.test(name)) delete process.env[name];
  }
  process.env.CODEBUDDY_AUTH_TOKEN = token;
  process.env.CODEBUDDY_BASE_URL = endpoint.origin + '/v2';
  process.env.ACC_PRODUCT_CONFIG_PATH = productPath;
  const cli = path.join(install, 'resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs');
  process.argv = [process.execPath, cli, ...process.argv.slice(2)];
  await import(pathToFileURL(cli).href);
}
main().catch(() => {
  // Native crypto errors and provider errors can contain credential fragments.
  process.stderr.write('WorkBuddy local login is unavailable or expired. Open the installed WorkBuddy client and sign in again.\n');
  process.exitCode = 1;
});
