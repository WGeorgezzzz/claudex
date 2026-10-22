import assert from 'node:assert/strict';
import test from 'node:test';

import { nextMonitorCalendarRun, parseMonitorCalendarSchedule } from '@/shared/index.js';

const next=(rule:unknown,after:string)=>nextMonitorCalendarRun(parseMonitorCalendarSchedule(rule)!,new Date(after)).toISOString();

test('daily rules use explicit timezone, roll dates and keep fractional-hour offsets',()=>{
  assert.equal(next({frequency:'daily',time:'09:00',timeZone:'Asia/Shanghai'},'2026-10-21T23:00:00Z'),'2026-10-22T01:00:00.000Z');
  assert.equal(next({frequency:'daily',time:'09:00',timeZone:'Asia/Shanghai'},'2026-10-22T01:00:00Z'),'2026-10-23T01:00:00.000Z');
  assert.equal(next({frequency:'daily',time:'09:00',timeZone:'Asia/Kathmandu'},'2026-10-21T23:00:00Z'),'2026-10-22T03:15:00.000Z');
});

test('weekly rules use ISO weekdays and canonicalize order and duplicates',()=>{
  const rule={frequency:'weekly',time:'09:00',timeZone:'Asia/Shanghai',weekdays:[5,1,5]};
  assert.deepEqual(parseMonitorCalendarSchedule(rule)?.weekdays,[1,5]);
  assert.equal(next(rule,'2026-10-22T01:01:00Z'),'2026-10-23T01:00:00.000Z');
  assert.equal(next(rule,'2026-10-23T01:01:00Z'),'2026-10-26T01:00:00.000Z');
});

test('spring-forward nonexistent local time is skipped, including a whole weekly slot',()=>{
  assert.equal(next({frequency:'daily',time:'02:30',timeZone:'America/New_York'},'2025-03-09T00:00:00Z'),'2025-03-10T06:30:00.000Z');
  assert.equal(next({frequency:'weekly',time:'02:30',timeZone:'America/New_York',weekdays:[7]},'2025-03-03T12:00:00Z'),'2025-03-16T06:30:00.000Z');
});

test('fall-back repeated local time chooses only its first occurrence',()=>{
  const rule={frequency:'daily',time:'01:30',timeZone:'America/New_York'};
  assert.equal(next(rule,'2025-11-02T00:00:00Z'),'2025-11-02T05:30:00.000Z');
  assert.equal(next(rule,'2025-11-02T05:31:00Z'),'2025-11-03T06:30:00.000Z');
});

test('invalid rules and unsupported fields are rejected instead of using server time',()=>{
  const valid={frequency:'daily',time:'09:00',timeZone:'Asia/Shanghai'};
  for(const bad of [{...valid,time:'24:00'},{...valid,timeZone:'Mars/Olympus'},{...valid,frequency:'monthly'},
    {...valid,weekdays:[1]},{...valid,interval:5},{...valid,frequency:'weekly',weekdays:[]},
    {...valid,frequency:'weekly',weekdays:[0,8]},{...valid,timeZone:''}])assert.throws(()=>parseMonitorCalendarSchedule(bad));
  assert.equal(parseMonitorCalendarSchedule(null),null);
});
