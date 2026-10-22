import type { MonitorCalendarSchedule } from '@/shared/types';

/** Chat's monitor panel and sidebar's task manager share the same cadence and explicit timezone controls. */
export function MonitorScheduleFields({value,onChange,minutes,onMinutesChange,intervalLabel,calendarEnabled,disabled=false}:{
  value:MonitorCalendarSchedule|null;onChange:(value:MonitorCalendarSchedule|null)=>void;minutes:number;
  onMinutesChange:(value:number)=>void;intervalLabel:string;calendarEnabled:boolean;disabled?:boolean;
}) {
  const inputClass='mt-1 block w-full rounded border bg-background p-2 text-sm disabled:opacity-50';
  return <fieldset disabled={disabled} className="space-y-2">
    <label className="block text-sm">重复方式<select aria-label="重复方式" value={value?.frequency??'interval'} className={inputClass} onChange={event=>{
      const frequency=event.target.value;
      if(frequency==='interval'){onChange(null);return;}
      onChange({frequency:frequency as 'daily'|'weekly',time:value?.time??'09:00',timeZone:value?.timeZone??Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(frequency==='weekly'?{weekdays:value?.weekdays??[1,2,3,4,5]}:{})});
    }}><option value="interval">按间隔</option><option value="daily" disabled={!calendarEnabled}>每天</option><option value="weekly" disabled={!calendarEnabled}>每周</option></select></label>
    {!calendarEnabled&&<p className="text-xs text-muted-foreground">日历调度需当前服务支持；未确认支持前只能使用间隔调度。</p>}
    {!value?<label className="block text-sm">间隔（分钟）<input aria-label={intervalLabel} type="number" required min={1} max={10080} value={minutes} onChange={event=>onMinutesChange(Number(event.target.value))} className={inputClass}/></label>:<>
      <div className="grid grid-cols-2 gap-3"><label className="block text-sm">执行时间<input aria-label="执行时间" type="time" required value={value.time} onInput={event=>onChange({...value,time:event.currentTarget.value})} onChange={event=>onChange({...value,time:event.target.value})} className={inputClass}/></label>
      <label className="block text-sm">时区<input aria-label="执行时区" required maxLength={100} placeholder="Asia/Shanghai" value={value.timeZone} onChange={event=>onChange({...value,timeZone:event.target.value})} className={inputClass}/></label></div>
      {value.frequency==='weekly'&&<div className="flex flex-wrap gap-3" role="group" aria-label="每周执行日期">{['周一','周二','周三','周四','周五','周六','周日'].map((label,index)=><label key={label} className="flex items-center gap-1 text-sm"><input type="checkbox" aria-label={label} checked={value.weekdays?.includes(index+1)??false} onChange={event=>onChange({...value,weekdays:event.target.checked?[...(value.weekdays??[]),index+1].sort((a,b)=>a-b):(value.weekdays??[]).filter(day=>day!==index+1)})}/>{label}</label>)}</div>}
      <p className="text-xs text-muted-foreground">按指定时区计算；夏令时不存在的时间跳过，重复时间只执行一次。恢复时等待下一个日历时刻。</p>
    </>}
  </fieldset>;
}
