import {useEffect,useState} from 'react';
import {api,readApiJson} from '@/shared/api';

export default function FileMetadata({path,projectId}:{path:string;projectId?:string}) {
  const [info,setInfo]=useState('');
  useEffect(()=>{let active=true;setInfo('');if(projectId)void api.readFile(projectId,path,{metadata:true}).then(readApiJson<{size:number;modified:string}>).then(data=>{if(active)setInfo(`${data.size.toLocaleString()} 字节 · 修改时间 ${new Date(data.modified).toLocaleString()}`);}).catch(e=>{if(active)setInfo(String(e.message ?? e));});return()=>{active=false;};},[path,projectId]);
  return <p className="break-all text-xs" role="status">{info}</p>;
}
