import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const stage=path.resolve(root,'.desktop-build','workbench');
const expectedParent=path.resolve(root,'.desktop-build');
if (path.dirname(stage)!==expectedParent || path.basename(stage)!=='workbench') throw new Error('Unsafe staging path.');
const profile=JSON.parse(await fs.readFile(path.join(root,'workbench-profile.json'),'utf8'));
const sourcePackage=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const electronVersion=JSON.parse(await fs.readFile(path.join(root,'node_modules/electron/package.json'),'utf8')).version;
if (process.platform!=='win32' || process.arch!=='x64') throw new Error('This packaging entry currently targets Windows x64 only.');
if (!process.versions.node.startsWith('22.')) throw new Error('Build with Node.js 22 so the bundled runtime and native dependencies have the same ABI.');

// The only recursive removal targets this verified disposable build directory.
await fs.rm(stage,{recursive:true,force:true});
await fs.mkdir(stage,{recursive:true});
const allowed=(source)=>!/(?:^|[\\/])(?:tests|\.env|\.verification)(?:[\\/]|$)|\.(?:db|sqlite3?)(?:-(?:wal|shm))?$|\.(?:log|pid|map)$|\.test\.[cm]?[jt]s$/.test(source);
for (const name of ['electron','public','dist']) {
  await fs.cp(path.join(root,name),path.join(stage,name),{recursive:true,filter:allowed});
}
await fs.copyFile(path.join(root,'workbench-profile.json'),path.join(stage,'workbench-profile.json'));
for (const name of ['LICENSE','NOTICE']) await fs.copyFile(path.join(root,name),path.join(stage,name));
const serverRoot=path.join(stage,'server');
await fs.mkdir(serverRoot,{recursive:true});
for (const name of ['dist-server','dist','public','server','shared']) {
  await fs.cp(path.join(root,name),path.join(serverRoot,name),{recursive:true,filter:allowed});
}
await fs.mkdir(path.join(serverRoot,'scripts'),{recursive:true});
await fs.copyFile(path.join(root,'scripts/fix-node-pty.js'),path.join(serverRoot,'scripts/fix-node-pty.js'));
await fs.copyFile(path.join(root,'scripts/fix-codex-windows-console.mjs'),path.join(serverRoot,'scripts/fix-codex-windows-console.mjs'));
await fs.copyFile(path.join(root,'package-lock.json'),path.join(serverRoot,'package-lock.json'));
await fs.writeFile(path.join(serverRoot,'package.json'),JSON.stringify({
  ...sourcePackage,scripts:{postinstall:sourcePackage.scripts.postinstall},
},null,2));
await new Promise((resolve,reject)=>{
  const child=spawn('npm',['ci','--omit=dev','--no-audit','--no-fund'],{
    cwd:serverRoot,stdio:'inherit',env:{...process.env,ELECTRON_SKIP_BINARY_DOWNLOAD:'1'},windowsHide:true,
  });
  child.once('error',reject);
  child.once('exit',code=>code===0?resolve():reject(new Error(`Production dependency installation exited ${code}`)));
});
// Both the native shell and Node backend resolve packages from this root.
// Do not rebuild Node-ABI dependencies for Electron: the backend has its own Node.
const moduleSource=path.resolve(serverRoot,'node_modules'), moduleTarget=path.resolve(stage,'node_modules');
if (!moduleSource.startsWith(stage+path.sep) || !moduleTarget.startsWith(stage+path.sep)) throw new Error('Unsafe dependency move.');
await fs.rename(moduleSource,moduleTarget);
await fs.access(path.join(moduleTarget,'@anthropic-ai','claude-agent-sdk-win32-x64','claude.exe'));
await fs.mkdir(path.join(stage,'runtime'),{recursive:true});
await fs.copyFile(process.execPath,path.join(stage,'runtime','node.exe'));
await fs.writeFile(path.join(stage,'build-provenance.json'),JSON.stringify({
  product:profile.productName,version:profile.version,sourceCommit:process.env.GITHUB_SHA||'local',
  node:process.version,nodeAbi:process.versions.modules,electron:electronVersion,upstreamBaseVersion:profile.upstreamBaseVersion||'1.37.5',
},null,2));
await fs.writeFile(path.join(stage,'package.json'),JSON.stringify({
  name:'claudex-desktop',version:profile.version,productName:profile.productName,
  description:'Nexagent independent desktop distribution',
  author:sourcePackage.author,license:sourcePackage.license,type:'module',main:'electron/main.js',
  dependencies:sourcePackage.dependencies,optionalDependencies:sourcePackage.optionalDependencies,
  build:{
    appId:profile.appId,productName:profile.productName,asar:false,electronVersion,
    npmRebuild:false,nodeGypRebuild:false,
    artifactName:'Nexagent-${version}-win-${arch}.${ext}',
    directories:{output:'../../release/workbench'},
    files:['electron/**','public/**','dist/**','server/**','runtime/**','node_modules/**',
      'workbench-profile.json','build-provenance.json','package.json','LICENSE','NOTICE'],
    protocols:[{name:profile.productName,schemes:[profile.protocol]}],
    win:{target:[{target:'nsis',arch:['x64']}],icon:'electron/assets/logo-windows.ico',
      executableName:'Nexagent',signAndEditExecutable:true},
    nsis:{oneClick:false,perMachine:false,allowToChangeInstallationDirectory:true,runAfterFinish:false,
      deleteAppDataOnUninstall:false,createDesktopShortcut:true,shortcutName:profile.productName},
  },
},null,2));
console.log(`Prepared ${profile.productName} ${profile.version} with Node ${process.version} at ${stage}`);
