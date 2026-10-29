import { copyTextToClipboard } from '@/shared/utils';

type LocalPathBridge = {
  openLocalPath?: (path: string) => Promise<unknown>;
  revealLocalPath?: (path: string) => Promise<unknown>;
  getCapabilities?: () => Promise<{ localPaths?: boolean }>;
};

/** Select a bridge by the requested file capability during shell upgrades. */
function findLocalPathBridge(reveal: boolean): LocalPathBridge | undefined {
  const bridge = window as unknown as {
    cloudcliDesktopNotifications?: LocalPathBridge;
    cloudcliDesktop?: LocalPathBridge;
  };
  const method = reveal ? 'revealLocalPath' : 'openLocalPath';
  return [bridge.cloudcliDesktopNotifications, bridge.cloudcliDesktop]
    .find(candidate => typeof candidate?.[method] === 'function');
}

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
  const api = findLocalPathBridge(reveal);
  const action = reveal ? api?.revealLocalPath : api?.openLocalPath;
  if (!api || !action) throw new Error('需在 Drover 桌面端使用；仍可复制路径');
  const upgrade = async () => {
    await copyLocalPath(path, reveal).catch(() => {});
    window.dispatchEvent(new Event('nexagent-desktop-update'));
    throw new Error('桌面端需重启以启用此功能；已尝试复制路径，可先粘贴到文件管理器。');
  };
  // Old preload scripts can expose the bridge but reject this newer probe.
  // Let the action itself decide whether the shell supports local paths.
  try {
    const capabilities = api.getCapabilities ? await api.getCapabilities() : null;
    if (capabilities?.localPaths === false) return upgrade();
  } catch { /* The local action may still be supported by this shell. */ }
  try { await action(reveal ? nativePath(path) : path); }
  catch (error) { if (/No handler registered|remote method/i.test(String(error))) return upgrade(); throw error; }
}
