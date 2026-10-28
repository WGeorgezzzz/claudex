import { installAuthorizationFixture, authenticateTestRequest } from '@/test-support/authorization-fixture.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type RequestHandler } from 'express';

import { matchesEllipsisPattern, splitEllipsisPattern } from '@/modules/file-tree/ellipsis-pattern.js';
import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import { createFileTreeService, parseByteRange } from '@/modules/file-tree/file-tree.service.js';
import type { FileTreeFileSystem, FileTreeServices } from '@/shared/types.js';

const realName = '02-left-bell-52002800000-0000-clutter10.mp4';

test('ellipsis patterns split on U+2026 and on three dots inside a basename', () => {
  assert.deepEqual(splitEllipsisPattern('02-left-…-clutter10.mp4'), ['02-left-', '-clutter10.mp4']);
  assert.deepEqual(splitEllipsisPattern('run...final.log'), ['run', 'final.log']);
  assert.deepEqual(splitEllipsisPattern('a…b…c.txt'), ['a', 'b', 'c.txt']);
  assert.equal(splitEllipsisPattern('report.md'), null);
  assert.equal(splitEllipsisPattern('...'), null);
  assert.equal(splitEllipsisPattern('…'), null);
});

test('ellipsis patterns match prefix, ordered middles and suffix without overlap', () => {
  const parts = splitEllipsisPattern('02-left-…-clutter10.mp4')!;
  assert.equal(matchesEllipsisPattern(realName, parts), true);
  assert.equal(matchesEllipsisPattern('02-right-bell-clutter10.mp4', parts), false);
  assert.equal(matchesEllipsisPattern('02-left-bell-clutter10.mp4.part', parts), false);
  assert.equal(matchesEllipsisPattern('aXa', ['aXa', 'a']), false);
  assert.equal(matchesEllipsisPattern('a-b-c.txt', ['a', 'b', 'c.txt']), true);
  assert.equal(matchesEllipsisPattern('a-c.txt-b', ['a', 'b', 'c.txt']), false);
});

test('byte ranges follow RFC 9110 single-range semantics', () => {
  assert.deepEqual(parseByteRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseByteRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseByteRange('bytes=0-5000', 1000), { start: 0, end: 999 });
  assert.equal(parseByteRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseByteRange('bytes=0-1,5-6', 1000), null);
  assert.equal(parseByteRange('items=0-1', 1000), null);
});

const realFileSystem: FileTreeFileSystem = {
  access: (candidate) => fsPromises.access(candidate),
  stat: (candidate) => fsPromises.stat(candidate),
  lstat: (candidate) => fsPromises.lstat(candidate),
  openDirectory: async function* (directory) { yield* await fsPromises.opendir(directory); },
  realpath: (candidate) => fsPromises.realpath(candidate),
  readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
  writeTextFile: async () => { throw new Error('read-only test adapter'); },
  makeDirectory: async () => { throw new Error('read-only test adapter'); },
  rename: async () => { throw new Error('read-only test adapter'); },
  removeDirectory: async () => { throw new Error('read-only test adapter'); },
  unlink: async () => { throw new Error('read-only test adapter'); },
  copyFile: async () => { throw new Error('read-only test adapter'); },
  createReadStream: (filePath, range) => fs.createReadStream(filePath, range),
};

async function withProject(run: (root: string, service: FileTreeServices) => Promise<void>) {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-ellipsis-'));
  try {
    await fsPromises.mkdir(path.join(root, 'preview-r6'));
    await fsPromises.writeFile(path.join(root, 'preview-r6', realName), Buffer.alloc(1000, 7));
    await fsPromises.writeFile(path.join(root, 'preview-r6', '02-right-bell-1-clutter10.mp4'), 'x');
    await fsPromises.mkdir(path.join(root, 'preview-r6', '02-left-dir-clutter10.mp4'));
    const service = createFileTreeService({
      fileSystem: realFileSystem,
      projects: { getProjectPathById: async () => root },
      workspace: { rootPath: root, validatePath: async (candidate) => ({ valid: path.relative(root,candidate) === '' || (!path.relative(root,candidate).startsWith('..') && !path.isAbsolute(path.relative(root,candidate))), resolvedPath: candidate }), resolveReadOnlyRootPath: async () => null },
      resolveMimeType: (filePath) => filePath.endsWith('.mp4') ? 'video/mp4' : 'text/plain',
      fileSystemConcurrency: 4,
      logger: { error: () => undefined },
    });
    await run(root, service);
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
}

test('resolveFilePattern returns only existing files that match, never directories', async () => {
  await withProject(async (root, service) => {
    const absolute = await service.resolveFilePattern('p', path.join(root, 'preview-r6', '02-left-…-clutter10.mp4'));
    assert.deepEqual(absolute, { matches: [path.join(root, 'preview-r6', realName)], truncated: false });
    const relative = await service.resolveFilePattern('p', 'preview-r6\\02-...-clutter10.mp4');
    assert.equal(relative.matches.length, 2);
    assert.deepEqual((await service.resolveFilePattern('p', 'preview-r6/03-…-x.mp4')).matches, []);
    await assert.rejects(service.resolveFilePattern('p', path.join(os.tmpdir(), '..', 'a…b.txt')), { statusCode: 403 });
    await assert.rejects(service.resolveFilePattern('p', 'preview-r6/plain.mp4'), { statusCode: 400 });
    await assert.rejects(service.resolveFilePattern('p', 'missing/a…b.mp4'), { statusCode: 404 });
  });
});

installAuthorizationFixture();

test('content route serves byte ranges for video seeking and resolve-pattern returns the real path', async () => {
  await withProject(async (root, service) => {
    const app = express();
    app.use(authenticateTestRequest);
    const pass: RequestHandler = (_request, _response, next) => next();
    app.use('/api/file-tree', createFileTreeRouter({ ...service, resolveFilePattern: (_id, pattern) => service.resolveFilePattern('p', pattern) }, pass, { maximumFileSizeMegabytes: 1, maximumFileCount: 1 }, { error: () => undefined }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/file-tree/projects/project-1`;
      const pattern = await fetch(`${base}/files/resolve-pattern?path=${encodeURIComponent('preview-r6/02-left-…-clutter10.mp4')}`);
      assert.equal(pattern.status, 200);
      assert.deepEqual(await pattern.json(), { matches: [path.join(root, 'preview-r6', realName)], truncated: false });

      const url = `${base}/files/content?path=${encodeURIComponent('preview-r6/' + realName)}`;
      const full = await fetch(url);
      assert.equal(full.status, 200);
      assert.equal(full.headers.get('content-type'), 'video/mp4');
      assert.equal(full.headers.get('accept-ranges'), 'bytes');
      assert.equal((await full.arrayBuffer()).byteLength, 1000);

      const partial = await fetch(url, { headers: { Range: 'bytes=100-199' } });
      assert.equal(partial.status, 206);
      assert.equal(partial.headers.get('content-range'), 'bytes 100-199/1000');
      assert.equal((await partial.arrayBuffer()).byteLength, 100);

      assert.equal((await fetch(url, { headers: { Range: 'bytes=5000-' } })).status, 416);
      const head = await fetch(url, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-length'), '1000');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
