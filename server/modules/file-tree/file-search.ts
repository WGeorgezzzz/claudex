import { spawn } from 'node:child_process';
import path from 'node:path';
import { rgPath } from '@vscode/ripgrep';
import type { FileTreeNode } from '@/shared/types.js';

const EXCLUDED = ['node_modules','.git','.svn','.hg','.venv','venv','__pycache__','dist','build','.next','.nuxt','.cache','.parcel-cache','.pytest_cache','.mypy_cache','.tox','target','vendor','.gradle','.idea','coverage','.nyc_output'];
/** Native filename discovery: bounded time/count, no content reads or symlink traversal. */
export function searchFilePaths(root: string, query: string, respectGitignore = true): Promise<{files: FileTreeNode[]; truncated: boolean}> {
  const needle = query.slice(0,512).replaceAll('\\','/').toLowerCase();
  return new Promise((resolve,reject) => {
    const args = ['--files','--hidden','--null','--line-buffered','--no-ignore-parent','--no-require-git', ...(respectGitignore ? [] : ['--no-ignore']), ...EXCLUDED.flatMap(name => ['-g','!**/'+name+'/**'])];
    const child = spawn(rgPath,args,{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    const files: FileTreeNode[] = []; let pending = '', truncated = false, error = '', settled = false;
    // Windows can take time to deliver the close event after termination. The
    // response budget includes that wait: settle before signalling the child.
    const finish = () => {if(settled)return;settled=true;clearTimeout(timer);resolve({files,truncated});};
    const timer = setTimeout(() => {truncated = true;finish();child.kill();},1100);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data',(chunk: string) => {
      if(settled)return;
      const parts = (pending + chunk).split('\0'); pending = parts.pop() || '';
      for (const relative of parts) {
        if (files.length >= 100) {truncated = true;finish();child.kill();break;}
        if (!relative.replaceAll('\\','/').toLowerCase().includes(needle)) continue;
        files.push({name:path.basename(relative),path:path.resolve(root,relative),type:'file',size:0,modified:null,permissions:'000',permissionsRwx:'---------'});
      }
    });
    child.stderr.on('data',(chunk: string) => {error = (error + chunk).slice(0,1000);});
    child.on('error',cause => {if(settled)return;settled=true;clearTimeout(timer);reject(cause);});
    child.on('close',code => {if(settled)return;if(code && code > 1 && !files.length && !truncated){settled=true;clearTimeout(timer);reject(Error(error || 'File search failed'));}else finish();});
  });
}
