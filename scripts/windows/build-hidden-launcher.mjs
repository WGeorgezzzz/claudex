import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'win32') throw new Error('The hidden scheduled-task launcher is Windows-only.');
const output = path.resolve(process.argv[2] || '.desktop-build/hidden-launcher/ClaudexHidden.exe');
const source = path.join(path.dirname(fileURLToPath(import.meta.url)), 'HiddenLauncher.cs');
const compiler = path.join(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
fs.mkdirSync(path.dirname(output), { recursive: true });
execFileSync(compiler, ['/nologo', '/target:winexe', '/r:System.Web.Extensions.dll', `/out:${output}`, source], { windowsHide: true, stdio: 'pipe' });
console.log(`Built hidden scheduled-task launcher: ${output}`);
