import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@/shared/index.js';

/** Local administrator fallback for shells too old to register the restart IPC. The service stays running. */
export function restartInstalledDesktop() {
  if(process.platform!=='win32')throw new AppError('请关闭并重新打开桌面端。',{statusCode:409});
  const programs=path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData/Local'),'Programs');
  const executable=path.join(programs,'Claudex-local-0.8.0','Claudex.exe');
  if(!existsSync(executable))throw new AppError('未找到已安装的桌面端，请手动重新打开。',{statusCode:409});
  const quote=(s:string)=>"'"+s.replaceAll("'","''")+"'";
  const script=`Start-Sleep -Seconds 1; $desktopExe=${quote(executable)}; $desktopRoots=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $desktopExe -and $_.Name -eq 'Claudex.exe' -and $_.CommandLine -notmatch '--type=' }); foreach($desktopProcess in $desktopRoots){Stop-Process -Id $desktopProcess.ProcessId -ErrorAction Stop}; Start-Process -FilePath $desktopExe -ArgumentList '--local' -WindowStyle Hidden`;
  const child=spawn(path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,detached:true,stdio:'ignore'});child.unref();
  return {restarting:true};
}
