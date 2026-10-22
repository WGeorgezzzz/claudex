import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// SDK 0.156 has no spawn-options hook. Patch only its Codex launch and the
// CLI's native-child launch; never change global child_process behavior.
const require = createRequire(path.resolve(process.argv[2] || process.cwd(), 'package.json'));
const targets = [
  [(require.resolve.paths('@openai/codex-sdk') || []).map(dir => path.join(dir, '@openai/codex-sdk/dist/index.js')).find(existsSync), 'spawn(this.executablePath, commandArgs, {'],
  [require.resolve('@openai/codex/bin/codex.js'), 'spawn(binaryPath, process.argv.slice(2), {'],
];
for (const [filename, anchor] of targets) {
  if (!filename) throw new Error('Codex SDK is not installed');
  const source = await readFile(filename, 'utf8');
  const positions = source.split(anchor);
  if (positions.length !== 2) throw new Error(`Codex launch changed; review the console patch: ${filename}`);
  const options = positions[1].split('});', 1)[0];
  if (/windowsHide:\s*true/.test(options)) continue;
  if (/windowsHide:/.test(options)) throw new Error(`Unexpected windowsHide option: ${filename}`);
  if (!existsSync(`${filename}.cloudcli-console-original`)) await writeFile(`${filename}.cloudcli-console-original`,source,{flag:'wx'});
  await writeFile(filename, source.replace(anchor, `${anchor}\n      windowsHide: true,`));
  console.log(`[postinstall] Hide Codex subprocess windows: ${filename}`);
}
