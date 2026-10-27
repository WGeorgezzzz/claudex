import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, projectsDb, sessionsDb, userDb, userPreferencesDb, workspaceSectionsDb } from '@/modules/database/index.js';
import { projectOrganizationService } from '@/modules/project-organization/project-organization.service.js';

// Real SQLite fixtures exercise ownership and the same transactions used by HTTP handlers.
test('organization preserves legacy state, backs up before migration, survives reopening and rejects stale/foreign writes',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'organization-')),previous=process.env.DATABASE_PATH;
  closeConnection();process.env.DATABASE_PATH=path.join(root,'test.db');await initializeDatabase();
  try {
    const user=Number(userDb.createUser('owner','hash').id);
    sessionsDb.createAppSession('one','claude',root,'One');
    sessionsDb.createAppSession('two','codex',root,'Two');
    const second=path.join(root,'second');projectsDb.createProjectPath(second,'Legacy name');
    const firstId=projectsDb.getProjectPath(root)!.project_id,secondId=projectsDb.getProjectPath(second)!.project_id;
    const legacy={ 'claudex.workspaceSections':{revision:3,sections:[{id:'section',name:'Keep',collapsed:true}],assignments:[{kind:'session',targetId:'one',sectionId:'section'}]},'pinned-thread-ids':['one'],'electron-thread-read-state-v1':{one:12} };
    userPreferencesDb.savePreferences(user,legacy);
    const before=getConnection().prepare('SELECT * FROM sessions ORDER BY session_id').all();
    let view=projectOrganizationService.list(user);
    const update=(input:Record<string,unknown>)=>view=projectOrganizationService.update(user,{revision:view.revision,...input});
    assert.equal(view.projects.find(p=>p.id===secondId)?.name,'Legacy name');
    assert.equal(view.revision,0);assert.equal(fs.existsSync(process.env.DATABASE_PATH+'.before-project-organization-v1.sqlite'),false);
    update({action:'edit',projectId:firstId,name:'Multi root',rootPaths:[root,second]});
    assert.ok(fs.existsSync(process.env.DATABASE_PATH+'.before-project-organization-v1.sqlite'));
    update({action:'assign',sessionId:'one',projectId:secondId});
    assert.equal(view.sessions.find(s=>s.id==='one')?.cwd,root);
    update({action:'assign',sessionId:'two',projectId:secondId});
    update({action:'thread-order',projectId:secondId,ids:['two','one']});
    update({action:'collapse',projectId:firstId,collapsed:true});
    update({action:'move',projectId:secondId,direction:'up'});
    update({action:'mode',mode:'flat'});
    assert.throws(()=>projectOrganizationService.update(user,{revision:0,action:'mode',mode:'project'}),/changed/);
    assert.throws(()=>update({action:'thread-order',projectId:secondId,ids:['one','one']}),/exactly once/);
    assert.throws(()=>update({action:'edit',projectId:firstId,name:'bad',rootPaths:['relative']}),/absolute/);
    assert.equal(view.projects[0].id,secondId);
    assert.deepEqual(view.threadOrders[secondId],['two','one']);
    assert.deepEqual(getConnection().prepare('SELECT * FROM sessions ORDER BY session_id').all(),before);
    for(const [key,value]of Object.entries(legacy))assert.deepEqual(userPreferencesDb.getPreferences(user)[key],value);
    assert.equal(workspaceSectionsDb.read(user).sections[0].name,'Keep');
    sessionsDb.createAppSession('new','claude',root,'New');
    view=projectOrganizationService.list(user);assert.deepEqual(view.sessions.find(s=>s.id==='new')?.roots,[root,second]);
    const other=Number(userDb.createUser('other','hash').id);
    assert.deepEqual(projectOrganizationService.list(other).sessions,[]);
    assert.throws(()=>projectOrganizationService.update(other,{revision:0,action:'assign',sessionId:'one',projectId:null}),/unavailable/);
    closeConnection();await initializeDatabase();
    const restored=projectOrganizationService.list(user);assert.equal(restored.mode,'flat');assert.equal(restored.projects.find(p=>p.id===firstId)?.collapsed,true);
    assert.deepEqual(restored.threadOrders[secondId],['two','one']);
    assert.deepEqual(projectOrganizationService.list(user),restored);
    update({action:'assign',sessionId:'one',projectId:null});assert.equal(view.sessions.find(s=>s.id==='one')?.projectId,null);
  }finally{closeConnection();if(previous===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=previous;assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(root,{recursive:true,force:true});}
});

