import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { completeJsonlOffset, readAppendedJsonl } from '@/shared/utils.js';

test('JSONL byte offsets preserve CRLF, Chinese and a split UTF-8 record', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'incremental-jsonl-'));
  try {
    const file=path.join(dir,'session.jsonl');
    const first=JSON.stringify({text:'中文'})+'\r\n';
    const second=Buffer.from(JSON.stringify({text:'追加消息'})+'\r\n');
    await writeFile(file,Buffer.concat([Buffer.from(first),second.subarray(0,12)]));
    const a=await readAppendedJsonl(file,0);
    assert.deepEqual(a.records,[{text:'中文'}]);
    assert.equal(a.nextOffset,Buffer.byteLength(first));
    assert.equal(await completeJsonlOffset(file),a.nextOffset);
    await appendFile(file,second.subarray(12));
    const b=await readAppendedJsonl(file,a.nextOffset);
    assert.deepEqual(b.records,[{text:'追加消息'}]);
    assert.equal(b.nextOffset,Buffer.byteLength(first)+second.length);
    assert.deepEqual((await readAppendedJsonl(file,b.nextOffset)).records,[]);
    await writeFile(file,'{}\n');
    assert.equal((await readAppendedJsonl(file,b.nextOffset)).nextOffset,0);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
