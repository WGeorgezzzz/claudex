import fs from 'node:fs';

import { getConnection } from '@/modules/database/connection.js';
import { ownerPredicate } from '@/modules/database/ownership.js';
import { AppError } from '@/shared/index.js';
import type { ProjectOrganizationLayout } from '@/shared/types.js';

const KEY = 'nexagent.projectOrganization.v1';
const empty = (): ProjectOrganizationLayout => ({version:1,revision:0,sortVersion:2,mode:'flat',order:[],projects:{},threads:{},threadOrders:{}});

/** Project Organization retains legacy preferences and backs up the complete database before its first additive write. */
export const projectOrganizationDb = {
  read(userId: number): ProjectOrganizationLayout {
    const row=getConnection().prepare('SELECT preference_value FROM user_preferences WHERE user_id=? AND preference_key=?').get(userId,KEY) as {preference_value:string}|undefined;
    if(!row)return empty();
    const layout=JSON.parse(row.preference_value) as ProjectOrganizationLayout;
    return layout.sortVersion===2?layout:{...layout,sortVersion:2,mode:'flat'};
  },
  snapshot() {
    const db=getConnection();
    const projects=db.prepare(`SELECT project_id AS id,custom_project_name AS name,project_path AS path FROM projects WHERE ${ownerPredicate()} AND isArchived=0 ORDER BY rowid`).all() as {id:string;name:string;path:string}[];
    const sessions=db.prepare(`SELECT s.session_id AS id,COALESCE(s.custom_name,'New conversation') AS title,s.provider,s.project_path AS cwd,s.updated_at AS updatedAt,p.project_id AS sourceProjectId FROM sessions s LEFT JOIN projects p ON p.project_path=s.project_path AND p.owner_id=s.owner_id WHERE ${ownerPredicate('s')} AND s.isArchived=0 ORDER BY s.updated_at DESC,s.session_id`).all() as {id:string;title:string;provider:string;cwd:string|null;updatedAt:string;sourceProjectId:string|null}[];
    const children=db.prepare('SELECT r.session_id,m.id AS monitorId,m.name AS monitorName FROM monitor_runs r JOIN monitors m ON m.id=r.monitor_id WHERE r.session_id IS NOT NULL AND r.session_id<>m.session_id').all() as {session_id:string;monitorId:string;monitorName:string}[];
    const bySession=new Map(children.map(r=>[r.session_id,r]));
    return {projects,sessions:sessions.map(row=>({...row,updatedAt:/^\d{4}-\d{2}-\d{2} /.test(row.updatedAt)?row.updatedAt.replace(' ','T')+'Z':row.updatedAt,...(bySession.has(row.id)?{monitorId:bySession.get(row.id)!.monitorId,monitorName:bySession.get(row.id)!.monitorName}:{})}))};
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
