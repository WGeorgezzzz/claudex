import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Import dynamically after pinning all writable state to an isolated fixture.
const root=mkdtempSync(path.join(os.tmpdir(),'claudex-account-test-'));
process.env.DATABASE_PATH=path.join(root,'accounts.db');
writeFileSync(process.env.DATABASE_PATH,'');
process.env.CLOUDCLI_HOME=root;
process.env.VITE_IS_PLATFORM='true';
process.env.CLAUDEX_USERS_WORK_ROOT=path.join(root,'work');
process.env.CLAUDE_CONFIG_DIR=path.join(root,'admin-claude');
process.env.CODEX_HOME=path.join(root,'admin-codex');
process.env.CLAUDEX_USER_CONFIG_ROOT=path.join(root,'user-config');
process.env.CLAUDEX_MEMBER_TEMPLATE_DIR=path.join(root,'member-template');
const {initializeDatabase,userDb,getConnection,authSessionsDb,projectsDb}=await import('@/modules/database/index.js');
const {userManagementService}=await import('../user-management.service.js');
const {remoteIdentityService}=await import('../remote-identity.service.js');
const {authenticateToken,authenticateWebSocket,generateToken}=await import('../auth.middleware.js');
const {getCurrentUserContext,withUserContext}=await import('../user-context.js');
const express=(await import('express')).default;
const {authRoutes}=await import('../auth.module.js');

test('account lifecycle preserves roles, protects admin operations, and revokes disabled/password sessions',async()=>{
  await initializeDatabase();
  const admin=userDb.createUser('owner','unused');
  assert.equal(admin.role,'admin');
  let fallback=false;
  await authenticateToken({headers:{host:'127.0.0.1'},query:{},socket:{remoteAddress:'127.0.0.1'}},{},()=>{fallback=true;});
  assert.equal(fallback,true);
  assert.equal(authenticateWebSocket(undefined)?.userId,Number(admin.id));
  const a=await userManagementService.create(Number(admin.id),{username:'member-a',password:'initial-secret',access_sso_email:'a@example.com'});
  const id=Number(a.user!.id);
  assert.equal(a.user!.role,'member');
  let deniedStatus=0;
  await authenticateToken({headers:{},query:{},socket:{}},{setHeader(){},status(code:number){deniedStatus=code;return {json(){}};}},()=>{throw Error('Tokenless multiuser platform ingress');});
  assert.equal(deniedStatus,401);
  assert.equal(authenticateWebSocket(undefined),null);
  assert.equal(authenticateWebSocket(generateToken(a.user))?.userId,id);
  assert.equal(userDb.getUserBySsoEmail('A@example.com')?.id,id);
  await assert.rejects(userManagementService.create(id,{username:'bad-user',password:'secret'}));
  await assert.rejects(remoteIdentityService.configure(id,'remote-name','long-enough-password'));
  const token=generateToken(a.user);
  let seen:number|undefined;
  // This is a local token; retain the private gate's remote-device requirement.
  await authenticateToken({headers:{authorization:'Bearer '+token,host:'127.0.0.1'},query:{},socket:{remoteAddress:'127.0.0.1'}},{setHeader(){},status(){throw Error('Rejected valid token');}},()=>{seen=getCurrentUserContext()?.userId;});
  assert.equal(seen,id);
  const device=authSessionsDb.create(id,'remote');
  userManagementService.update(Number(admin.id),id,{is_active:false});
  assert.equal(userDb.getUserById(id),undefined);
  assert.equal(authSessionsDb.get(device),undefined);
  assert.equal(userDb.getSsoBinding('a@example.com')?.is_active,0);
  await assert.rejects(remoteIdentityService.login('member-a','initial-secret',undefined));
  userManagementService.update(Number(admin.id),id,{is_active:true});
  assert.equal((await remoteIdentityService.login('member-a','initial-secret',undefined)).id,id);
  await userManagementService.reset(Number(admin.id),id,{password:'replacement-secret'});
  await assert.rejects(remoteIdentityService.login('member-a','initial-secret',undefined));
  assert.equal((await remoteIdentityService.login('member-a','replacement-secret',undefined)).id,id);
  await assert.rejects(userManagementService.change(id,{current_password:'wrong',password:'next-secret'}));
  await userManagementService.change(id,{current_password:'replacement-secret',password:'next-secret'});
  assert.equal((await remoteIdentityService.login('member-a','next-secret',undefined)).id,id);
  const app=express();app.use(express.json());app.use('/api/auth',authRoutes);
  app.use((error: {statusCode?:number;message:string},_req:unknown,res:import('express').Response,_next:unknown)=>res.status(error.statusCode??500).json({error:error.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address() as {port:number};
  const request=(route:string,token:string,method='GET',body?:unknown)=>fetch('http://127.0.0.1:'+address.port+'/api/auth'+route,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  try {
    const adminToken=generateToken(userDb.getUserById(Number(admin.id)));
    const memberToken=generateToken(userDb.getUserById(id));
    assert.equal((await request('/users',memberToken)).status,403);
    assert.equal((await request('/remote-account',memberToken,'POST',{})).status,403);
    assert.equal((await request('/users',adminToken)).status,200);
    const created=await request('/users',adminToken,'POST',{username:'member-b',password:'new-secret'});
    assert.equal(created.status,200);
    const b=await created.json() as {user:{id:number}};
    assert.equal((await request('/users/'+b.user.id,adminToken,'PATCH',{is_active:false})).status,200);
    assert.equal((await request('/login','', 'POST',{username:'member-b',password:'new-secret'})).status,401);
  } finally {await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
  await initializeDatabase();
  assert.equal(userDb.getUserById(Number(admin.id))?.role,'admin');
  assert.equal(userDb.getUserById(id)?.role,'member');
  assert.equal((getConnection().prepare('SELECT count(*) n FROM users').get() as {n:number}).n,3);
});

test('member workspaces register atomically with member ownership and preserve existing projects',async t=>{
  await initializeDatabase();
  const adminId=Number(userDb.getUserByUsername('owner')!.id);
  const created=await userManagementService.create(adminId,{username:'project-owner',password:'project-secret'});
  const memberId=Number(created.user!.id);
  const workRoot=path.join(root,'work','project-owner');
  const other=await userManagementService.create(adminId,{username:'project-other',password:'project-secret'});
  const otherId=Number(other.user!.id);
  const db=getConnection();
  const rows=()=>db.prepare('SELECT * FROM projects WHERE owner_id=? ORDER BY project_path').all(memberId) as {
    project_id:string;project_path:string;custom_project_name:string;owner_id:number;isStarred:number;isArchived:number;
  }[];

  await t.test('new member sees exactly one named, unstarred and unarchived default project',()=>{
    assert.equal(rows().length,1);
    assert.equal(rows()[0].project_path,workRoot);
    assert.equal(rows()[0].owner_id,memberId);
    assert.equal(rows()[0].custom_project_name,'project-owner');
    assert.equal(rows()[0].isStarred,0);
    assert.equal(rows()[0].isArchived,0);
    assert.deepEqual(withUserContext(memberId,()=>projectsDb.getProjectPaths()).map(p=>p.project_path),[workRoot]);
    assert(!withUserContext(otherId,()=>projectsDb.getProjectPaths()).some(p=>p.project_path===workRoot));
    assert.equal(getCurrentUserContext(),undefined);
  });

  await t.test('foreign work root returns 409 and rolls back the entire new account',async()=>{
    const count=db.prepare('SELECT COUNT(*) n FROM users').get();
    await assert.rejects(userManagementService.create(adminId,{
      username:'project-collision',password:'project-secret',work_root:workRoot,
    }),{statusCode:409,message:'Work root project belongs to another user'});
    assert.equal(userDb.getUserByUsername('project-collision'),undefined);
    assert.deepEqual(db.prepare('SELECT COUNT(*) n FROM users').get(),count);
    assert.equal(rows().length,1);
  });

  await t.test('changing work root adds the new project and keeps the old project',()=>{
    const next=path.join(root,'work','project-next');
    userManagementService.update(adminId,memberId,{work_root:next});
    assert.equal(rows().length,2);
    assert(rows().some(p=>p.project_path===workRoot));
    assert(rows().some(p=>p.project_path===next&&p.custom_project_name==='project-owner'));
    assert.doesNotThrow(()=>userManagementService.update(adminId,memberId,{work_root:next}));
    assert.equal(rows().length,2);
  });

  await t.test('existing active or archived projects retain identity, display name and flags',()=>{
    // Both paths are authorized under the current root before it changes.
    const current=userDb.getUserById(memberId)!.work_root as string;
    for(const archived of [false,true]) {
      const existingPath=path.join(current,archived?'archived':'active');
      const project=withUserContext(memberId,()=>{
        const row=projectsDb.createProjectPath(existingPath,'Keep this name').project!;
        projectsDb.updateProjectIsStarred(existingPath,true);
        projectsDb.updateProjectIsArchived(existingPath,archived);
        return row;
      });
      const before=rows().find(p=>p.project_id===project.project_id);
      userManagementService.update(adminId,memberId,{work_root:existingPath});
      assert.deepEqual(rows().find(p=>p.project_id===project.project_id),before);
      userManagementService.update(adminId,memberId,{work_root:current});
    }
  });

  await t.test('update collision rolls back access settings without changing either project owner',()=>{
    const before=rows();
    const userBefore=userDb.getUserById(memberId);
    assert.throws(()=>userManagementService.update(adminId,memberId,{
      work_root:other.user!.work_root,access_sso_email:'rolled-back@example.com',
    }),{statusCode:409});
    assert.deepEqual(userDb.getUserById(memberId),userBefore);
    assert.deepEqual(rows(),before);
  });

  await t.test('unrelated updates do not recreate projects; administrator roots do not get projects',()=>{
    const before=rows();
    withUserContext(memberId,()=>projectsDb.deleteProjectPath(userDb.getUserById(memberId)!.work_root as string));
    const afterDelete=rows();
    userManagementService.update(adminId,memberId,{access_sso_email:'project-owner@example.com'});
    assert.deepEqual(rows(),afterDelete);
    assert.equal(rows().length,before.length-1);
    const adminProjects=db.prepare('SELECT * FROM projects WHERE owner_id=?').all(adminId);
    userManagementService.update(adminId,adminId,{work_root:path.join(root,'admin-work')});
    assert.deepEqual(db.prepare('SELECT * FROM projects WHERE owner_id=?').all(adminId),adminProjects);
  });

  await t.test('disabled members can be created or moved without making the account active',async()=>{
    await userManagementService.create(adminId,{
      username:'project-disabled',password:'project-secret',is_active:false,
    });
    const id=(db.prepare('SELECT id FROM users WHERE username=?').get('project-disabled') as {id:number}).id;
    assert.equal((db.prepare('SELECT is_active FROM users WHERE id=?').get(id) as {is_active:number}).is_active,0);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM projects WHERE owner_id=?').get(id) as {n:number}).n,1);
    userManagementService.update(adminId,id,{work_root:path.join(root,'disabled-next')});
    assert.equal((db.prepare('SELECT is_active FROM users WHERE id=?').get(id) as {is_active:number}).is_active,0);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM projects WHERE owner_id=?').get(id) as {n:number}).n,2);
    await assert.rejects(remoteIdentityService.login('project-disabled','project-secret',undefined));
  });
});
