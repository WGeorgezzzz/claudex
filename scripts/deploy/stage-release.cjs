const fs=require('fs'),path=require('path'),crypto=require('crypto'),{execFileSync}=require('child_process');
const src=process.cwd(),target=path.resolve(process.argv[2]||'../release-1'),root=path.dirname(target),app='C:/Users/73505/AppData/Local/Programs/Claudex-local-0.8.0/resources/app';
if(execFileSync('git',['status','--porcelain'],{cwd:src,encoding:'utf8'}).trim())throw Error('Source must be clean before build');
const gitBefore=execFileSync('git',['rev-parse','HEAD'],{cwd:src,encoding:'utf8'}).trim();
execFileSync(process.platform==='win32'?'cmd.exe':'npm',process.platform==='win32'?['/c','npm run build']:['run','build'],{cwd:src,stdio:'inherit',windowsHide:true,env:{...process.env,NODE_OPTIONS:''}});
if(gitBefore!==execFileSync('git',['rev-parse','HEAD'],{cwd:src,encoding:'utf8'}).trim())throw Error('Source changed during build');
if(execFileSync('git',['status','--porcelain'],{cwd:src,encoding:'utf8'}).trim())throw Error('Source changed during build');
if(fs.existsSync(target))throw Error('Refuse to overwrite an existing release');
fs.mkdirSync(target,{recursive:true});for(const name of ['dist','dist-server','public','scripts','server','shared','package.json','package-lock.json','electron'])fs.cpSync(src+'/'+name,target+'/'+name,{recursive:true});if(!fs.existsSync(target+'/node_modules'))fs.symlinkSync(fs.realpathSync(src+'/node_modules'),target+'/node_modules','junction');
fs.writeFileSync(target+'/build-provenance.json',JSON.stringify({git:gitBefore,builtAt:new Date().toISOString()}));
const git=execFileSync('git',['rev-parse','HEAD'],{cwd:src,encoding:'utf8'}).trim();fs.writeFileSync(target+'/frontend-release.json',JSON.stringify({name:'integrated2',git,at:new Date().toISOString()}));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(dir+'/'+e.name):[dir+'/'+e.name]);}
const shellFiles=[];for(const file of files(src+'/electron')){const rel=path.relative(src,file).replaceAll('\\','/');fs.mkdirSync(path.dirname(target+'/desktop-shell/'+rel),{recursive:true});fs.copyFileSync(file,target+'/desktop-shell/'+rel);shellFiles.push({file:rel,sha256:hash(file),originalSha256:fs.existsSync(app+'/'+rel)?hash(app+'/'+rel):null});}fs.writeFileSync(target+'/desktop-shell-manifest.json',JSON.stringify({files:shellFiles},null,2));
const hashes={};for(const folder of ['dist','dist-server','electron','scripts/gemini-desktop'])for(const file of files(target+'/'+folder))hashes[path.relative(target,file).replaceAll('\\','/')]=hash(file);fs.writeFileSync(target+'/release-manifest.json',JSON.stringify({git,at:new Date().toISOString(),hashes},null,2));console.log(JSON.stringify({target,git,files:Object.keys(hashes).length}));
