import path from 'node:path';

import { withUserContext, assertUserPath } from '@/modules/auth/index.js';
import { projectOrganizationDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/index.js';

const invalid=(message:string)=>new AppError(message,{statusCode:400});
/** Sidebar organization uses explicit thread assignments, preserving physical project/session records. */
export const projectOrganizationService = {
  list(userId:number) {
    const layout=projectOrganizationDb.read(userId);
    const snapshot=withUserContext(userId,()=>projectOrganizationDb.snapshot());
    const projects=snapshot.projects.map(project=>({...project,name:layout.projects[project.id]?.name||project.name||project.path,rootPaths:layout.projects[project.id]?.rootPaths??[project.path],collapsed:layout.projects[project.id]?.collapsed??false}));
    projects.sort((a,b)=>{const rank=(id:string)=>layout.order.includes(id)?layout.order.indexOf(id):layout.order.length;return rank(a.id)-rank(b.id);});
    const sessions=snapshot.sessions.map(session=>{
      const explicit=layout.threads[session.id];
      const inferred=projects.find(project=>project.id===session.sourceProjectId)??projects.find(project=>project.rootPaths.some(root=>path.resolve(root)===path.resolve(session.cwd||'.')));
      const projectId=explicit ? (projects.some(p=>p.id===explicit.projectId)?explicit.projectId:null) : inferred?.id??null;
      return {...session,projectId,roots:explicit?.roots??(session.cwd?[session.cwd]:[]),cwd:explicit?.cwd??session.cwd??''};
    });
    return {revision:layout.revision,mode:layout.mode,projects,sessions,threadOrders:layout.threadOrders};
  },
  update(userId:number,input:Record<string,unknown>) {
    if(!Number.isSafeInteger(input.revision))throw invalid('A revision is required.');
    const snapshot=this.list(userId);
    projectOrganizationDb.update(userId,Number(input.revision),layout=>{
      if(input.action==='mode') {
        if(input.mode!=='project'&&input.mode!=='flat')throw invalid('Choose project or flat.');layout.mode=input.mode;return;
      }
      const project=snapshot.projects.find(p=>p.id===input.projectId);
      if(input.action==='assign') {
        const session=snapshot.sessions.find(s=>s.id===input.sessionId);
        if(!session)throw new AppError('Conversation unavailable.',{statusCode:403});
        if(input.projectId!==null&&!project)throw invalid('Project unavailable.');
        layout.threads[session.id]={projectId:project?.id??null,cwd:session.cwd,roots:session.roots};return;
      }
      if(input.action==='thread-order') {
        const projectId=input.projectId===null?null:project?.id;
        if(projectId===undefined)throw invalid('Project unavailable.');
        const ids=input.ids;
        const visible=new Set(snapshot.sessions.filter(s=>s.projectId===projectId).map(s=>s.id));
        if(!Array.isArray(ids)||ids.length!==visible.size||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!visible.has(id)))throw invalid('Order must contain every project conversation exactly once.');
        layout.threadOrders[projectId??'projectless']=ids;return;
      }
      if(!project)throw invalid('Project unavailable.');
      if(input.action==='move') {
        if(input.direction!=='up'&&input.direction!=='down')throw invalid('Choose up or down.');
        const ids=snapshot.projects.map(p=>p.id),index=ids.indexOf(project.id),next=index+(input.direction==='up'?-1:1);
        if(next>=0&&next<ids.length)[ids[index],ids[next]]=[ids[next],ids[index]];layout.order=ids;return;
      }
      const current={name:project.name,rootPaths:project.rootPaths,collapsed:project.collapsed};
      if(input.action==='collapse') {
        if(typeof input.collapsed!=='boolean')throw invalid('Collapsed must be boolean.');current.collapsed=input.collapsed;
      } else if(input.action==='edit') {
        const name=typeof input.name==='string'?input.name.trim():'';
        const roots=input.rootPaths;
        if(!name||name.length>120||!Array.isArray(roots)||!roots.length||roots.length>32||roots.some(root=>typeof root!=='string'||!path.isAbsolute(root)||root.length>4096))throw invalid('Use a name and 1–32 absolute root paths.');
        for(const root of roots)assertUserPath(userId,root);
        current.name=name;current.rootPaths=[...new Set([project.path,...roots.map(root=>path.normalize(root))])];
      } else throw invalid('Unknown organization action.');
      layout.projects[project.id]=current;
    });
    return this.list(userId);
  },
};
