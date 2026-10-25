import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await fs.access(path.join(root, 'dist-server/server/modules/cli/cli.js'));
await fs.access(path.join(root, 'dist/index.html'));
await fs.copyFile(path.join(root, 'server/.npmignore'), path.join(root, 'dist-server/.npmignore'));
