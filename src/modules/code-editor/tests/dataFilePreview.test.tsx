import assert from 'node:assert/strict';
import {test} from 'vitest';
import {parseDelimited} from '@/modules/code-editor/DataFilePreview';
test('CSV handles quoted commas, escaped quotes and multiline cells; TSV preserves columns',()=>{
 assert.deepEqual(parseDelimited('name,value\n"a,b","say ""yes"""\n"two\nlines",42',','),[['name','value'],['a,b','say "yes"'],['two\nlines','42']]);
 assert.deepEqual(parseDelimited('a\tb\n1\t2','\t'),[['a','b'],['1','2']]);
 assert.equal(parseDelimited('x\n'.repeat(10000),',').length,1000);
});
