import { describe, expect, it } from 'vitest';
import { cleanMonitorReport } from '../../../shared/monitorReport';

describe('monitor protocol visibility during streaming',()=>{
 it('hides every partial prefix and growing protocol payload',()=>{
  const protocol='<monitor-probe>{"script":"private"}</monitor-probe>';
  for(let n=2;n<=protocol.length;n++)expect(cleanMonitorReport('报告\n'+protocol.slice(0,n))).toBe('报告');
  expect(cleanMonitorReport('报告<monitor-state>private</monitor-state><monitor-meta>private')).toBe('报告');
 });
 it('keeps ordinary fenced protocol examples and code intact',()=>{
  const code='```xml\n<monitor-probe>example</monitor-probe>\n```';
  expect(cleanMonitorReport(code+'\n<monitor-state>private</monitor-state>')).toBe(code);
 });
});
