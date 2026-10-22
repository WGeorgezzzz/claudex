import path from 'node:path';

/** Main-process IPC and desktop tests share validated local paths; no shell command is constructed. */
export async function openLocalPath(filePath, openPath) {
  const candidate=typeof filePath==='string'?filePath.trim():'';
  if (!candidate || candidate.includes('\0') || !path.isAbsolute(candidate)) throw new Error('Only an absolute local path can be opened.');
  const error=await openPath(candidate);
  if (error) throw new Error(error);
  return {path:candidate};
}
