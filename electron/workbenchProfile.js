import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Main and packaging tests share the product identity, without depending on Electron. */
export function loadWorkbenchProfile(appRoot) {
  try {
    const profile=JSON.parse(readFileSync(path.join(appRoot,'workbench-profile.json'),'utf8'));
    if (!profile.productName || !profile.appId || !profile.protocol || !profile.storageFolder
      || /[\\/]|^\.\.?$/.test(profile.storageFolder)
      || !Number.isInteger(profile.defaultPort) || profile.defaultPort<1024 || profile.defaultPort>65535) {
      throw new Error('Invalid Workbench product profile.');
    }
    return profile;
  } catch (error) {
    if (error.code==='ENOENT') return null;
    throw error;
  }
}

/** LocalServerController persists one installation identity in the isolated desktop profile. */
export async function ensureWorkbenchIdentity(userDataPath) {
  await fs.mkdir(userDataPath,{recursive:true});
  const file=path.join(userDataPath,'workbench-instance.json');
  try {
    await fs.writeFile(file,JSON.stringify({id:randomUUID()},null,2),{flag:'wx'});
  } catch(error) {if(error.code!=='EEXIST')throw error;}
  const record=JSON.parse(await fs.readFile(file,'utf8'));
  if (!/^[a-f0-9-]{36}$/i.test(record.id||'')) throw new Error('Workbench installation identity is invalid.');
  return record.id;
}

/** LocalServerController derives owned paths after discarding unrelated inherited launch overrides.
 * Explicit provider paths are opt-in; an unconfigured installation uses its own Claude directory. */
export function buildWorkbenchServerEnvironment({userDataPath,instanceId,port,settings={},inherited=process.env,bundledClaudePath,runtimeDirectory,version}) {
  const environment={...inherited};
  const inheritedPath=Object.entries(environment).find(([key])=>key.toLowerCase()==='path')?.[1] || '';
  const discarded=new Set(['ELECTRON_RUN_AS_NODE','ELECTRON_NODE_PATH','ELECTRON_SERVER_ENTRY','DATABASE_PATH',
    'CLOUDCLI_LOCAL_SERVER_URL','CLOUDCLI_DESKTOP_LOCAL_SERVER_URL','ELECTRON_LOCAL_SERVER_URL',
    'CLOUDCLI_SERVER_PORT','CLOUDCLI_DESKTOP_LOCAL_SERVER_PORT','PORT','SERVER_PORT',
    'CLAUDE_CONFIG_DIR','CLAUDE_CLI_PATH','CLOUDCLI_HOME','API_KEY','PATH','NODE_OPTIONS','NODE_PATH','NODE_ENV',
    'CLOUDCLI_DISTRIBUTION','CLOUDCLI_INSTANCE_ID','CLOUDCLI_WORKBENCH_VERSION','CLOUDCLI_PROTECTED_SESSIONS_FILE']
    .map(key=>key.toLowerCase()));
  for (const key of Object.keys(environment)) if(discarded.has(key.toLowerCase()))delete environment[key];
  const serviceHome=path.join(userDataPath,'server');
  return {
    ...environment,
    HOST:settings.exposeLocalServerOnNetwork?'0.0.0.0':'127.0.0.1',
    SERVER_PORT:String(port),
    NODE_ENV:'production',
    CLOUDCLI_HOME:serviceHome,
    CLAUDEX_LOCAL_IDENTITY:'1',
    CLAUDEX_PRIVATE_GATE:'1',
    DATABASE_PATH:path.join(serviceHome,'auth.db'),
    CLAUDE_CONFIG_DIR:settings.claudeConfigDir||path.join(userDataPath,'providers','claude'),
    ...((settings.claudeCliPath||bundledClaudePath)?{CLAUDE_CLI_PATH:settings.claudeCliPath||bundledClaudePath}:{}),
    PATH:[runtimeDirectory,bundledClaudePath?path.dirname(bundledClaudePath):null,inheritedPath].filter(Boolean).join(path.delimiter),
    CLOUDCLI_DISTRIBUTION:'workbench',
    CLOUDCLI_INSTANCE_ID:instanceId,
    CLOUDCLI_WORKBENCH_VERSION:version||'development',
    ...(existsSync(path.join(userDataPath,'protected-sessions.json'))?{CLOUDCLI_PROTECTED_SESSIONS_FILE:path.join(userDataPath,'protected-sessions.json')}:{})
  };
}
