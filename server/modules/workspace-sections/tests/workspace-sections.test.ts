import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { workspaceSectionsService } from '@/modules/workspace-sections/workspace-sections.service.js';

test('sections persist ordering, collapse and assignments with revision protection and account isolation', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'claudex-sections-'));const old=process.env.DATABASE_PATH;
  closeConnection();process.env.DATABASE_PATH=path.join(root,'test.db');await initializeDatabase();
  try {
    const user=Number(userDb.createUser('sections','hash').id);sessionsDb.createAppSession('chat','claude',root,'Chat');
    const project=projectsDb.getProjectPath(root)!;
    let view=workspaceSectionsService.update(user,{revision:0,action:'create',name:'Research'});
    const id=view.sections[0].id;
    assert.throws(()=>workspaceSectionsService.update(user,{revision:0,action:'create',name:'stale'}),/changed/);
    view=workspaceSectionsService.update(user,{revision:view.revision,action:'assign',kind:'project',targetId:project.project_id,sectionId:id});
    view=workspaceSectionsService.update(user,{revision:view.revision,action:'assign',kind:'session',targetId:'chat',sectionId:id});
    view=workspaceSectionsService.update(user,{revision:view.revision,action:'collapse',id,collapsed:true});
    closeConnection();await initializeDatabase();assert.equal(workspaceSectionsService.list(user).sections[0].collapsed,true);
    assert.equal(workspaceSectionsService.list(user+1).sections.length,0);
    view=workspaceSectionsService.update(user,{revision:view.revision,action:'create',name:'Other'});const other=view.sections[1].id;
    view=workspaceSectionsService.update(user,{revision:view.revision,action:'move',id:other,direction:'up'});assert.equal(view.sections[0].id,other);
    view=workspaceSectionsService.update(user,{revision:view.revision,action:'delete',id});assert.equal(view.assignments.length,0);
    assert.ok(sessionsDb.getSessionById('chat'));assert.ok(projectsDb.getProjectById(project.project_id));
  } finally {closeConnection();if(old===undefined)delete process.env.DATABASE_PATH;else process.env.DATABASE_PATH=old;assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(root,{recursive:true,force:true});}
});
