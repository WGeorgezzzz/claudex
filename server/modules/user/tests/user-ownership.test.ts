import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, getConnection, initializeDatabase, projectsDb, sessionsDb, sessionDraftsDb, userDb } from '@/modules/database/index.js';
import { getUserContext, withUserContext } from '@/modules/auth/index.js';
import { userRoutes } from '@/modules/user/index.js';

test('HTTP drafts enforce session/project owners and member Git config injects only that user identity',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'user-owner-http-'));
  const changes:NodeJS.ProcessEnv={DATABASE_PATH:path.join(root,'test.db'),CLAUDEX_USER_CONFIG_ROOT:path.join(root,'config'),CLAUDE_CONFIG_DIR:path.join(root,'admin-claude'),CODEX_HOME:path.join(root,'admin-codex'),GIT_AUTHOR_NAME:'Inherited Admin',GIT_AUTHOR_EMAIL:'admin@example.com',GIT_COMMITTER_NAME:'Inherited Admin',GIT_COMMITTER_EMAIL:'admin@example.com'};
  const previous=Object.fromEntries(Object.keys(changes).map(key=>[key,process.env[key]]));
  closeConnection();Object.assign(process.env,changes);await initializeDatabase();
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{(req as express.Request & {user:{id:number}}).user={id:Number(req.headers['x-test-user'])};next();});
  app.use('/user',userRoutes);
  app.use((error:{statusCode?:number;message:string},_req:express.Request,res:express.Response,_next:express.NextFunction)=>{res.status(error.statusCode??500).json({error:error.message});});
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  try{
    const admin=Number(userDb.createUser('admin','hash').id),a=Number(userDb.createUser('member-a','hash').id),b=Number(userDb.createUser('member-b','hash').id);
    const aRoot=path.join(root,'a'),bRoot=path.join(root,'b');await mkdir(aRoot);await mkdir(bRoot);
    getConnection().prepare('UPDATE users SET work_root=? WHERE id=?').run(aRoot,a);
    getConnection().prepare('UPDATE users SET work_root=? WHERE id=?').run(bRoot,b);
    withUserContext(a,()=>sessionsDb.createAppSession('a-session','claude',aRoot,'A secret'));
    withUserContext(admin,()=>sessionsDb.createAppSession('admin-session','claude',root,'Admin secret'));
    const project=withUserContext(a,()=>projectsDb.getProjectPath(aRoot))!;
    const address=server.address();assert.ok(address&&typeof address!=='string');
    const request=(user:number,method:string,url:string,body?:unknown)=>fetch(`http://127.0.0.1:${address.port}/user${url}`,{method,headers:{'content-type':'application/json','x-test-user':String(user)},body:body===undefined?undefined:JSON.stringify(body)});
    for(const user of [b,admin])for(const scope of ['a-session',`project:${project.project_id}`]){
      assert.equal((await request(user,'PUT','/drafts',{scope,text:'foreign'})).status,403);
      assert.equal((await request(user,'DELETE','/drafts',{scope})).status,403);
    }
    assert.equal((await request(b,'PUT','/drafts',{scope:'admin-session',text:'foreign'})).status,403);
    for(const scope of ['a-session',`project:${project.project_id}`])assert.equal((await request(a,'PUT','/drafts',{scope,text:'own draft'})).status,200);
    sessionDraftsDb.saveDraft(b,'a-session',{text:'legacy leaked draft',queuedMessage:null});
    const drafts=await (await request(b,'GET','/drafts')).json() as {drafts:unknown[]};assert.deepEqual(drafts.drafts,[]);
    assert.equal((await request(a,'POST','/git-config',{gitName:'Member A',gitEmail:'a@example.com'})).status,200);
    const env=getUserContext(a).env;
    assert.equal(env.GIT_AUTHOR_NAME,'Member A');assert.equal(env.GIT_COMMITTER_NAME,'Member A');
    assert.equal(env.GIT_AUTHOR_EMAIL,'a@example.com');assert.equal(env.GIT_COMMITTER_EMAIL,'a@example.com');
    assert.equal(getUserContext(b).env.GIT_AUTHOR_NAME,undefined);
    assert.equal(process.env.GIT_AUTHOR_NAME,'Inherited Admin');
    assert.equal(userDb.getGitConfig(admin)?.git_name,null);
  }finally{
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    closeConnection();for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    await rm(root,{recursive:true,force:true});
  }
});
