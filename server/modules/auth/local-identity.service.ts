import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { IncomingMessage } from 'node:http';

import { userDb } from '@/modules/database/index.js';
import { AppError, getCloudCliHomeDir } from '@/shared/index.js';
import { isLocalRequest } from '@/modules/auth/access-boundary.js';

let capability:string|undefined;
const tickets=new Map<string,{userId:number;expires:number}>();

/** Server startup creates an OS-user-readable capability; browser code never receives it. */
export function initializeLocalIdentity() {
  if(process.env.CLAUDEX_LOCAL_IDENTITY!=='1')return;
  const home=getCloudCliHomeDir();mkdirSync(home,{recursive:true});
  const file=path.join(home,'local-identity.key');
  if(!existsSync(file))writeFileSync(file,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});
  if(process.platform==='win32'){
    const account=process.env.USERDOMAIN?`${process.env.USERDOMAIN}\\${userInfo().username}`:userInfo().username;
    execFileSync('icacls.exe',[file,'/inheritance:r','/grant:r',`${account}:(F)`],{windowsHide:true,stdio:'ignore'});
  }else chmodSync(file,0o600);
  capability=readFileSync(file,'utf8').trim();
  if(!/^[a-f0-9]{64}$/.test(capability))throw Error('Invalid local identity file.');
  if(!userDb.hasUsers()){
    const bcrypt=createRequire(import.meta.url)('bcrypt') as {hashSync(p:string,n:number):string};
    const user=userDb.createUser(userInfo().username||'local-owner',bcrypt.hashSync(randomBytes(32).toString('hex'),12));
    // Local identity must not force a global Git identity change before opening the workspace.
    userDb.completeOnboarding(Number(user.id));
  }
}

/** Auth routes issue a short-lived, one-use ticket only to a local OS capability holder. */
export function issueLocalTicket(req:IncomingMessage,key:unknown) {
  if(!capability||!isLocalRequest(req)||req.headers.origin||typeof key!=='string'||key.length!==capability.length||!timingSafeEqual(Buffer.from(key),Buffer.from(capability)))throw new AppError('Local identity unavailable.',{statusCode:403});
  const user=userDb.getFirstUser();if(!user)throw new AppError('Complete initial account setup first.',{statusCode:409});
  for(const [id,t] of tickets)if(t.expires<Date.now())tickets.delete(id);
  if(tickets.size>=100)throw new AppError('Too many pending login tickets.',{statusCode:429});
  const ticket=randomBytes(32).toString('hex');tickets.set(ticket,{userId:user.id,expires:Date.now()+60000});return ticket;
}

/** Auth exchanges the native client's fragment ticket once; remote hosts cannot redeem local credentials. */
export function consumeLocalTicket(req:IncomingMessage,input:unknown) {
  if(!isLocalRequest(req)||typeof input!=='string')throw new AppError('Invalid local ticket.',{statusCode:403});
  const ticket=tickets.get(input);tickets.delete(input);
  if(!ticket||ticket.expires<Date.now())throw new AppError('Local ticket expired or already used.',{statusCode:401});
  const user=userDb.getUserById(ticket.userId);if(!user)throw new AppError('Local user unavailable.',{statusCode:401});return user;
}
