const test = require('node:test'), assert = require('node:assert/strict');
const { parseClaude } = require('./worker.cjs');
test('WenClaude quota parser uses labelled windows and never token totals', () => {
  const row = parseClaude('今日 Token 9M 今日消费 $50 官方额度 5小时限制 重置时间 周六 10月24日 01:40 已使用 98% 所有模型 重置时间 周二 10月27日 14:00 已使用 38% 最近使用');
  assert.equal(row.status, 'ok'); assert.equal(row.windows[0].remainingPercent, 2);
  assert.equal(row.windows[1].remainingPercent, 62); assert.match(row.windows[0].resetLabel, /01:40/);
});
test('missing or invalid quota fails without claiming a zero or full balance', () => {
  assert.equal(parseClaude('今日 Token 9M 今日消费 $50').status, 'unavailable');
  assert.equal(parseClaude('5小时限制 已使用 999%').status, 'unavailable');
});
test('a missing window cannot borrow a neighboring percentage', () => {
  const row = parseClaude('官方额度 5小时限制 重置时间 明天 Fable 暂无数据 所有模型 已使用 20% 最近使用');
  assert.equal(row.status, 'unavailable');
});
