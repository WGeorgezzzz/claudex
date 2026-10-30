import { useEffect, useState } from 'react';
import { api } from '@/shared/api';
import type { FileTreeNode } from '@/shared/types';
type Args = { files: FileTreeNode[]; projectId?:string; expandDirectories: (paths:string[])=>void };
export function useFileTreeSearch({files,projectId}: Args) {
  const [searchQuery,setSearchQuery] = useState('');
  const [results,setResults] = useState<FileTreeNode[]>([]);
  const [searchError,setSearchError] = useState('');
  const [truncated,setTruncated] = useState(false);
  useEffect(() => {
    setResults([]); setSearchError(''); setTruncated(false);
    if (!searchQuery.trim() || !projectId) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await api.searchFiles(projectId,searchQuery.trim(),{signal:controller.signal});
        if (!response.ok) throw Error('文件搜索失败，请重试');
        const data = await response.json();
        if (!controller.signal.aborted) {setResults(data.files);setTruncated(data.truncated);}
      } catch (cause) {if (!controller.signal.aborted) setSearchError(String(cause));}
    },150);
    return () => {clearTimeout(timer);controller.abort();};
  },[projectId,searchQuery]);
  return {searchQuery,setSearchQuery,filteredFiles:searchQuery.trim()?results:files,searchError,truncated};
}
