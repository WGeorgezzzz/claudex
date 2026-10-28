import { useState } from 'react';
import { copyLocalPath, openLocalFile } from '@/shared/localPath';

export default function LocalFileActions({path, directory = false, compact = true}: {path:string;directory?:boolean;compact?:boolean}) {
  const [message,setMessage] = useState('');
  const run = (operation:()=>Promise<unknown>, success='') => {setMessage('');void operation().then(()=>setMessage(success)).catch(e=>setMessage(String(e.message ?? e)));};
  const actions = <div className="flex flex-wrap items-center gap-1 text-xs">
    <button type="button" title="本地打开" className="rounded border px-2 py-1" onClick={()=>run(()=>openLocalFile(path))}>本地打开</button>
    <button type="button" title="打开所在文件夹" className="rounded border px-2 py-1" onClick={()=>run(()=>openLocalFile(path,true))}>打开所在文件夹</button>
    <button type="button" title="复制文件路径" className="rounded border px-2 py-1" onClick={()=>run(()=>copyLocalPath(path),'已复制')}>复制路径</button>
    <button type="button" title="复制文件夹路径" className="rounded border px-2 py-1" onClick={()=>run(()=>copyLocalPath(path,true,directory),'已复制')}>复制文件夹路径</button>
    {message && <span role="status" className="break-all">{message}</span>}
  </div>;
  return compact ? <details className="relative shrink-0"><summary title="文件操作" className="cursor-pointer rounded border px-2 py-1" aria-label="文件操作">⋯</summary><div className="absolute right-0 z-[10001] w-56 rounded border bg-popover p-2 shadow-lg">{actions}</div></details> : actions;
}
