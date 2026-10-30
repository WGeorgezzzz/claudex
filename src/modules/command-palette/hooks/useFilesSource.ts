import { api } from '@/shared/api';
import { useApiSource } from '@/modules/command-palette/hooks/useApiSource';
export type FileResult = {path:string;name:string};
export function useFilesSource(projectId: string | undefined, enabled: boolean, query = '') {
  return useApiSource<FileResult,{files:FileResult[]}>({enabled:enabled && !!projectId,deps:[projectId,query],fetcher:signal=>api.searchFiles(projectId!,query,{signal}),parse:data=>data.files || []});
}
