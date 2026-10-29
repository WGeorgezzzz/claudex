import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMonitorReport } from '../monitor-isolated.service.js';
import { decodeScriptOutput } from '../monitor-script.service.js';

test('internal probe does not leak into report or fallback state', () => {
  assert.deepEqual(parseMonitorReport('正常\n<monitor-probe>{"script":"private"}</monitor-probe>'), { report: '正常', state: '正常' });
});
test('state remains available while probe blocks are removed', () => {
  assert.deepEqual(parseMonitorReport('完成<monitor-state>next</monitor-state><MONITOR-PROBE>{}</MONITOR-PROBE>'), { report: '完成', state: 'next' });
});
test('incomplete protocol blocks never leak script fragments', () => {
  assert.equal(parseMonitorReport('正常\n<monitor-probe>{"script":').report, '正常');
});
test('ordinary fenced code examples remain intact', () => {
  const text = '示例\n```xml\n<monitor-probe>example</monitor-probe>\n```';
  assert.equal(parseMonitorReport(text).report, text);
});
test('native WSL UTF16 diagnostics and UTF8 events decode without mojibake', () => {
  const diagnostic = 'wsl: 无法启动 /bin/bash\r\n';
  assert.equal(decodeScriptOutput(Buffer.from(diagnostic, 'utf16le')), diagnostic);
  assert.equal(decodeScriptOutput(Buffer.from('\uFEFF' + diagnostic, 'utf16le')), diagnostic);
  const event = '{"type":"done","msg":"完成"}';
  assert.equal(decodeScriptOutput(Buffer.from(event)), event);
});
