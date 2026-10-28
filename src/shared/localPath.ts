import { copyTextToClipboard } from '@/shared/utils';

export function nativePath(path: string): string {
  return /^(?:[a-z]:[\\/]|\\\\)/i.test(path) ? path.replace(/\//g, '\\') : path;
}
export function folderPath(path: string, directory = false): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  if (directory) return nativePath(/^[a-z]:$/i.test(normalized) ? normalized + '/' : normalized || '/');
  const parent = normalized.slice(0, normalized.lastIndexOf('/'));
  return nativePath(/^[a-z]:$/i.test(parent) ? parent + '/' : parent || '/');
}
export async function copyLocalPath(path: string, folder = false, directory = false) {
  if (!await copyTextToClipboard(folder ? folderPath(path, directory) : nativePath(path))) throw new Error('复制路径失败');
}
export async function openLocalFile(path: string, reveal = false) {
  const bridge = (window as unknown as {cloudcliDesktop?: {openLocalPath?: (p:string)=>Promise<unknown>; revealLocalPath?: (p:string)=>Promise<unknown>};cloudcliDesktopNotifications?: {openLocalPath?: (p:string)=>Promise<unknown>;revealLocalPath?: (p:string)=>Promise<unknown>}});
  const api = bridge.cloudcliDesktopNotifications ?? bridge.cloudcliDesktop;
  const action = reveal ? api?.revealLocalPath : api?.openLocalPath;
  if (!action) throw new Error('需在 Nexagent 桌面端使用；仍可复制路径');
  await action(nativePath(path));
}
