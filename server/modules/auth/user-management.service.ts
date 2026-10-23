import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { userDb, authSessionsDb, getConnection } from '@/modules/database/index.js';
import { AppError } from '@/shared/index.js';

import { authSessionEvents } from './auth.middleware.js';

const bcrypt = createRequire(import.meta.url)('bcrypt') as {hash(p:string,n:number):Promise<string>;compare(p:string,h:string):Promise<boolean>};
function fail(message:string, statusCode=400): never {throw new AppError(message,{statusCode});}
function admin(id:number) {if(userDb.getUserById(id)?.role !== 'admin') fail('Administrator required',403);}
function password(value:unknown):string {
  if(typeof value!=='string'||value.length<6||Buffer.byteLength(value,'utf8')>72)fail('Password must be at least 6 characters and at most 72 UTF-8 bytes');
  return value;
}
function revoke(id:number) {
  for(const row of authSessionsDb.list(id) as {id:string}[]) {authSessionsDb.revoke(id,row.id);authSessionEvents.emit('revoked',row.id);}
}
function access(input:Record<string,unknown>, username:string) {
  const root=input.work_root ?? path.join(process.env.CLAUDEX_USERS_WORK_ROOT || 'D:\\claudex-users',username);
  if(typeof root!=='string'||!path.isAbsolute(root)||root.includes('\0'))fail('Work root must be an absolute path');
  const folders=input.allowed_folders ?? [];
  if(!Array.isArray(folders)||folders.some(v=>typeof v!=='string'||!path.isAbsolute(v)||v.includes('\0')))fail('Allowed folders must be absolute paths');
  const email=input.access_sso_email === null || input.access_sso_email === '' || input.access_sso_email === undefined ? null : String(input.access_sso_email).trim().toLowerCase();
  if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('Invalid SSO email');
  if(email===process.env.CLAUDEX_ACCESS_SSO_EMAIL?.trim().toLowerCase())fail('This SSO email is reserved for the administrator');
  if(input.is_active!==undefined && typeof input.is_active!=='boolean')fail('is_active must be boolean');
  return {root:path.resolve(root),folders:folders as string[],email,active:input.is_active!==false};
}
function activeAdmins():number {
  return (userDb.listUsers() as {role:string;is_active:number}[]).filter(u=>u.role==='admin'&&u.is_active).length;
}
function conflict(error:unknown): never {
  if(typeof error==='object'&&error!==null&&'code' in error&&error.code==='SQLITE_CONSTRAINT_UNIQUE')fail('Username or SSO email already exists',409);
  throw error;
}
/** Auth routes use this service for administrator operations and verified self password changes. */
export const userManagementService = {
  list(id:number) {admin(id);return {users:userDb.listUsers()};},
  async create(id:number,input:Record<string,unknown>) {
    admin(id);
    const username=typeof input.username==='string'?input.username.trim():'';
    if(!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,63}$/.test(username)||username.endsWith('.')||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(username))fail('Invalid username');
    if(username===authSessionsDb.remote()?.username)fail('Username is reserved for remote administrator login',409);
    const hash=await bcrypt.hash(password(input.password),12);
    const a=access(input,username);
    try {
      const user=getConnection().transaction(()=>{
        const created=userDb.createUser(username,hash);
        userDb.updateAccess(Number(created.id),a.root,a.folders,a.email,a.active);
        // Members start in the workspace; Git identity is optional, not a login gate.
        userDb.completeOnboarding(Number(created.id));
        mkdirSync(a.root,{recursive:true});
        return userDb.getUserById(Number(created.id));
      })();
      return {success:true,user};
    } catch(error) {conflict(error);}
  },
  update(id:number,target:number,input:Record<string,unknown>) {
    admin(id);
    const existing=(userDb.listUsers() as {id:number;username:string;role:string;work_root:string|null;allowed_folders:string;access_sso_email:string|null;is_active:number}[]).find(u=>u.id===target);
    if(!existing)fail('User not found',404);
    const role=input.role===undefined?existing.role:input.role;
    if(role!=='admin'&&role!=='member')fail('Role must be admin or member');
    if(role!==existing.role){
      if(target===id)fail('You cannot change your own role');
      if(existing.role==='admin'&&activeAdmins()<=1)fail('At least one administrator is required');
    }
    if(role==='admin'&&input.is_active===false)fail('The administrator cannot be disabled');
    const {role:_role,...accessInput}=input;
    input=accessInput;
    const a=access({work_root:existing.work_root??undefined,allowed_folders:JSON.parse(existing.allowed_folders),access_sso_email:existing.access_sso_email,is_active:Boolean(existing.is_active),...input},existing.username);
    try {
      getConnection().transaction(()=>{
        mkdirSync(a.root,{recursive:true});
        userDb.updateAccess(target,a.root,a.folders,a.email,role==='admin'?true:a.active);
        if(role!==existing.role)userDb.setRole(target,role as 'admin'|'member');
      })();
    }catch(error){conflict(error);}
    // Disabled devices must not revive when the account is enabled again; a role
    // change also invalidates tokens that still carry the previous role.
    if (!a.active || role!==existing.role) revoke(target);
    return {success:true};
  },
  remove(id:number,target:number) {
    admin(id);
    const existing=(userDb.listUsers() as {id:number;role:string}[]).find(u=>u.id===target);
    if(!existing)fail('User not found',404);
    if(target===id)fail('You cannot delete your own account');
    if(existing.role==='admin'&&activeAdmins()<=1)fail('At least one administrator is required');
    revoke(target);
    userDb.softDelete(target);
    return {success:true};
  },
  async reset(id:number,target:number,input:Record<string,unknown>) {
    admin(id);
    if(!(userDb.listUsers() as {id:number}[]).some(u=>u.id===target))fail('User not found',404);
    userDb.setPassword(target,await bcrypt.hash(password(input.password),12));revoke(target);
    return {success:true};
  },
  async change(id:number,input:Record<string,unknown>) {
    const user=userDb.getUserById(id);
    const full=user&&userDb.getUserByUsername(user.username);
    if(!full||typeof input.current_password!=='string'||!await bcrypt.compare(input.current_password,full.password_hash))fail('Current password is incorrect',401);
    userDb.setPassword(id,await bcrypt.hash(password(input.password),12));revoke(id);
    return {success:true};
  },
};
