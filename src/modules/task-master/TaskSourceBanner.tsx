import { useEffect,useState } from 'react';
import { Link } from 'react-router-dom';
import { inboxTasksApi } from '@/shared/api';
/** A normal conversation retains a link back to the task that launched it. */
export function TaskSourceBanner({sessionId}:{sessionId:string|null|undefined}){
  const [source,setSource]=useState<{projectId:string;taskId:string;title:string}|null>(null);
  useEffect(()=>{let live=true;if(!sessionId){setSource(null);return;}void inboxTasksApi.sessionSource(sessionId).then(r=>r.ok?r.json():null).then(data=>{if(live)setSource(data?.data??data);}).catch(()=>{});return()=>{live=false;};},[sessionId]);
  return source?.taskId?<Link to={'/tasks?project='+encodeURIComponent(source.projectId)+'&task='+encodeURIComponent(source.taskId)} className="mx-4 mt-2 block truncate rounded-lg border bg-muted/40 px-3 py-2 text-xs text-primary">来自任务：{source.title} · 返回任务</Link>:null;
}
