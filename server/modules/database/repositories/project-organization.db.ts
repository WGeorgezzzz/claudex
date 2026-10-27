import fs from 'node:fs';

import { getConnection } from '@/modules/database/connection.js';
import { ownerPredicate } from '@/modules/database/ownership.js';
import { AppError } from '@/shared/index.js';
import type { ProjectOrganizationLayout } from '@/shared/types.js';

const KEY = 'nexagent.projectOrganization.v1';
const empty = (): ProjectOrganizationLayout => ({version:1,revision:0,mode:'project',order:[],projects:{},threads:{},threadOrders:{}});

/** Project Organization retains legacy preferences and backs up the complete database before its first additive write. */
export const projectOrganizationDb = {
  read(userId: number): ProjectOrganizationLayout {
    const row=getConnection().prepare('SELECT preference_value FROM user_preferences WHERE user_id=? AND preference_key=?').get(userId,KEY) as {preference_value:string}|undefined;
    return row ? JSON.parse(row.preference_value) : empty();
  },
  snapshot() {
    const db=getConnection();
    const projects=db.prepare(`SELECT project_id AS id,custom_project_name AS name,project_path AS path FROM projects WHERE ${ownerPredicate()} AND isArchived=0 ORDER BY rowid`).all() as {id:string;name:string;path:string}[];
    const sessions=db.prepare(`SELECT s.session_id AS id,COALESCE(s.custom_name,'New conversation') AS title,s.provider,s.project_path AS cwd,s.updated_at AS updatedAt,p.project_id AS sourceProjectId FROM sessions s LEFT JOIN projects p ON p.project_path=s.project_path AND p.owner_id=s.owner_id WHERE ${ownerPredicate('s')} AND s.isArchived=0 ORDER BY s.updated_at DESC,s.session_id`).all() as {id:string;title:string;provider:string;cwd:string|null;updatedAt:string;sourceProjectId:string|null}[];
    return {projects,sessions};
  },
  recordNewSession(userId:number,sessionId:string,projectId:string,cwd:string) {
    const layout=this.read(userId);
    if(!layout.revision||userId<1)return;
    this.update(userId,layout.revision,current=>{current.threads[sessionId]={projectId,cwd,roots:current.projects[projectId]?.rootPaths??[cwd]};});
  },
  update(userId:number,revision:number,change:(layout:ProjectOrganizationLayout)=>void) {
    const db=getConnection();
    // VACUUM INTO captures committed WAL pages without stopping the running server.
    const backup=db.name+'.before-project-organization-v1.sqlite';
    if(db.name!==':memory:'&&!fs.existsSync(backup)) db.prepare('VACUUM INTO ?').run(backup);
    return db.transaction(()=>{
      const layout=this.read(userId);
      if(layout.revision!==revision)throw new AppError('Project organization changed; refresh and try again.',{statusCode:409});
      change(layout);layout.revision++;
      db.prepare('INSERT INTO user_preferences(user_id,preference_key,preference_value) VALUES(?,?,?) ON CONFLICT(user_id,preference_key) DO UPDATE SET preference_value=excluded.preference_value,updated_at=CURRENT_TIMESTAMP').run(userId,KEY,JSON.stringify(layout));
      return layout;
    }).immediate();
  },
};
