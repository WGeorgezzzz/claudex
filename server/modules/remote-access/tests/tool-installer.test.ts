import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { installDevTunnel, verifyMicrosoftBinary } from '../tool-installer.js';

test('Windows verifies the real Microsoft signature despite inherited foreign modules and rejects an unsigned file', {skip: process.platform !== 'win32'}, async () => {
  const old = process.env.PSModulePath;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexagent-signature-'));
  try {
    process.env.PSModulePath = path.join(dir, 'incompatible-powershell-modules');
    const signer = await verifyMicrosoftBinary(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'));
    assert.match(signer, /^[A-F0-9]{40}$/);
    const unsigned = path.join(dir, 'unsigned.exe'); await fs.writeFile(unsigned, 'not a signed executable');
    await assert.rejects(verifyMicrosoftBinary(unsigned), /Invalid Microsoft signature/);
  } finally {
    if (old === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = old;
    await fs.rm(dir, {recursive:true,force:true});
  }
});
test('Linux installer verifies official artifact origin and checksum without executing an untrusted binary', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexagent-linux-install-'));
  const bytes = Buffer.alloc(12000); bytes.set([0x7f, 0x45, 0x4c, 0x46]);
  const response = (digest: string, origin = 'https://tunnelsassetsprod.blob.core.windows.net/cli/linux-x64-devtunnel') => {
    const value = new Response(bytes, {headers: {'content-md5': digest}}); Object.defineProperty(value, 'url', {value: origin}); return value;
  };
  const digest = createHash('md5').update(bytes).digest('base64');
  try {
    await assert.rejects(installDevTunnel({platform:'linux',arch:'x64',directory:dir,request:async()=>response('wrong')}), /checksum/);
    await assert.rejects(installDevTunnel({platform:'linux',arch:'x64',directory:dir,request:async()=>response(digest,'https://untrusted.example/cli/binary')}), /origin/);
    const receipt = await installDevTunnel({platform:'linux',arch:'x64',directory:dir,request:async()=>response(digest)});
    assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await fs.readFile(path.join(dir, 'devtunnel')), bytes);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
