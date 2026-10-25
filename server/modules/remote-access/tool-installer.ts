import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { AppError } from '@/shared/index.js';

const execute = promisify(execFile);
/** Installer and Windows regression fixtures verify with the OS security module, independently of an inherited PowerShell 7 module path. */
export async function verifyMicrosoftBinary(file: string) {
  const systemRoot = process.env.SystemRoot ?? 'C:/Windows';
  const { stdout } = await execute(path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; Import-Module (Join-Path $PSHOME "Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1"); $s=Get-AuthenticodeSignature -LiteralPath $env:NEXAGENT_VERIFY_TOOL; if($s.Status -ne "Valid" -or $s.SignerCertificate.Subject -notmatch "O=Microsoft Corporation"){throw "Invalid Microsoft signature"}; $s.SignerCertificate.Thumbprint'],
  { windowsHide: true, timeout: 30000, env: { ...process.env, PSModulePath: path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/Modules'), NEXAGENT_VERIFY_TOOL: file } });
  return stdout.trim();
}
/** Remote Access keeps optional, explicitly downloaded tunnel tools outside repository and release artifacts. */
export function tunnelToolsDirectory() { return path.join(os.homedir(), '.cloudcli', 'tools'); }

/** Settings downloads official artifacts only on explicit command; verify platform signature/checksum before making the CLI executable. Tests inject artifact transport. */
export async function installDevTunnel(options: {platform?: NodeJS.Platform; arch?: string; directory?: string; request?: typeof fetch} = {}) {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  if (!['win32', 'darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch) || platform === 'linux' && arch !== 'x64') {
    throw new AppError('请从 https://learn.microsoft.com/azure/developer/dev-tunnels/get-started 安装本平台的官方 CLI 后重新检测。', { statusCode: 400 });
  }
  const dir = options.directory ?? tunnelToolsDirectory(); await fs.mkdir(dir, { recursive: true });
  const temporary = path.join(dir, platform === 'win32' ? 'devtunnel.download.exe' : 'devtunnel.download');
  const artifact = platform === 'win32' ? `win-${arch}` : platform === 'darwin' ? `osx-${arch}-zip` : 'linux-x64';
  const source = `https://aka.ms/TunnelsCliDownload/${artifact}`;
  const response = await (options.request ?? fetch)(source, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('Microsoft CLI download failed');
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== 'tunnelsassetsprod.blob.core.windows.net' || !finalUrl.pathname.startsWith('/cli/')) throw new Error('Unexpected Microsoft download origin');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 10000 || bytes.length > 150 * 1024 * 1024) throw new Error('Unexpected CLI download size');
  const contentMd5 = response.headers.get('content-md5');
  if (platform !== 'win32' && (!contentMd5 || createHash('md5').update(bytes).digest('base64') !== contentMd5)) throw new Error('Microsoft artifact checksum mismatch');
  let executable: Buffer = bytes;
  if (platform === 'darwin') {
    const archive = await JSZip.loadAsync(bytes);
    const entries = Object.values(archive.files).filter(entry => !entry.dir && path.posix.basename(entry.name) === 'devtunnel');
    if (entries.length !== 1) throw new Error('Unexpected Microsoft CLI archive');
    executable = await entries[0].async('nodebuffer');
  }
  if (platform === 'linux' && !executable.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error('Unexpected Linux executable');
  await fs.writeFile(temporary, executable, { mode: 0o600 });
  try {
    let signerThumbprint: string | null = null;
    if (platform === 'win32') signerThumbprint = await verifyMicrosoftBinary(temporary);
    if (platform === 'darwin') {
      await execute('/usr/bin/codesign', ['--verify', '--strict', temporary], { timeout: 30000 });
      const { stderr } = await execute('/usr/bin/codesign', ['--display', '--verbose=4', temporary], { timeout: 30000 });
      if (!/Authority=Developer ID Application: Microsoft Corporation \(UBF8T346G9\)/.test(stderr)) throw new Error('Invalid Microsoft signature');
      signerThumbprint = 'Microsoft Corporation (UBF8T346G9)';
    }
    await fs.chmod(temporary, 0o700);
    const destination = path.join(dir, platform === 'win32' ? 'devtunnel.exe' : 'devtunnel');
    await fs.rename(temporary, destination);
    const receipt = { source, sha256: createHash('sha256').update(bytes).digest('hex'), contentMd5, signerThumbprint, verifiedAt: new Date().toISOString() };
    await fs.writeFile(path.join(dir, 'devtunnel-receipt.json'), JSON.stringify(receipt, null, 2));
    return receipt;
  } finally { await fs.rm(temporary, { force: true }); }
}
