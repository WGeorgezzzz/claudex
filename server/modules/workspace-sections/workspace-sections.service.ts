import { randomUUID } from 'node:crypto';

import { withUserContext } from '@/modules/auth/index.js';
import { getSessionOwnerId, projectsDb, sessionsDb, workspaceSectionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/index.js';

const invalid = (message: string) => new AppError(message, { statusCode: 400 });

/** Sidebar routes manage section organization without changing projects, transcripts, or live runs. */
export const workspaceSectionsService = {
  list(userId: number) {
    const layout = workspaceSectionsDb.read(userId);
    layout.assignments=layout.assignments.filter(item=>item.kind==='session' ? getSessionOwnerId(item.targetId)===userId : withUserContext(userId,()=>Boolean(projectsDb.getProjectById(item.targetId))));
    const sessionItems = layout.assignments.filter(item => item.kind === 'session').flatMap(item => {
      const session = withUserContext(userId,()=>sessionsDb.getSessionById(item.targetId));
      if (!session || session.isArchived) return [];
      return [{ sessionId: session.session_id, title: session.custom_name || 'New conversation', provider: session.provider,
        projectPath: session.project_path, projectId: session.project_path ? withUserContext(userId,()=>projectsDb.getProjectPath(session.project_path!))?.project_id ?? null : null }];
    });
    return { ...layout, sessionItems };
  },
  update(userId: number, input: Record<string, unknown>) {
    if (!Number.isSafeInteger(input.revision)) throw invalid('A layout revision is required.');
    const action = input.action;
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    workspaceSectionsDb.update(userId, Number(input.revision), layout => {
      if (action === 'create' || action === 'create-assign') {
        if (!name || name.length > 80 || layout.sections.length >= 50) throw invalid('Use a name of 1–80 characters; at most 50 sections.');
        if (layout.sections.some(row => row.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw invalid('同名分区已存在，请换一个名称。');
        const id = randomUUID();
        // Creation and assignment share the preference transaction: rejection leaves neither behind.
        if (action === 'create-assign') {
          const kind = input.kind; const targetId = typeof input.targetId === 'string' ? input.targetId : '';
          if (kind !== 'project' && kind !== 'session') throw invalid('Choose a project or session.');
          if (kind === 'session' && getSessionOwnerId(targetId) !== userId) throw new AppError('Conversation belongs to another user or is unavailable.', { statusCode: 403 });
          const target = withUserContext(userId, () => kind === 'project' ? projectsDb.getProjectById(targetId) : sessionsDb.getSessionById(targetId));
          if (!target || target.isArchived) throw invalid('Choose an active project or session.');
          layout.assignments = layout.assignments.filter(row => row.kind !== kind || row.targetId !== targetId);
          layout.assignments.push({ kind, targetId, sectionId: id });
        }
        layout.sections.push({ id, name, collapsed: false }); return;
      }
      if (action === 'assign') {
        const kind = input.kind; const targetId = typeof input.targetId === 'string' ? input.targetId : '';
        if (!['project', 'session'].includes(String(kind))) throw invalid('Choose a project or session.');
        if (kind==='session' && getSessionOwnerId(targetId)!==userId) throw new AppError('Conversation belongs to another user or is unavailable.',{statusCode:403});
        const target = withUserContext(userId,()=>kind === 'project' ? projectsDb.getProjectById(targetId) : sessionsDb.getSessionById(targetId));
        if (!target || target.isArchived) throw invalid('Choose an active project or session.');
        if (input.sectionId !== null && !layout.sections.some(row => row.id === input.sectionId)) throw invalid('Section does not exist.');
        layout.assignments = layout.assignments.filter(row => row.kind !== kind || row.targetId !== targetId);
        if (input.sectionId !== null) layout.assignments.push({ kind: kind as 'project' | 'session', targetId, sectionId: String(input.sectionId) });
        return;
      }
      const index = layout.sections.findIndex(row => row.id === input.id);
      if (index < 0) throw invalid('Section does not exist.');
      if (action === 'rename') {
        if (!name || name.length > 80) throw invalid('Use a name of 1–80 characters.');
        if (layout.sections.some((row, other) => other !== index && row.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw invalid('同名分区已存在，请换一个名称。');
        layout.sections[index].name = name;
      } else if (action === 'collapse') {
        if (typeof input.collapsed !== 'boolean') throw invalid('Collapsed must be a boolean.');
        layout.sections[index].collapsed = input.collapsed;
      } else if (action === 'delete') {
        layout.sections.splice(index, 1); layout.assignments = layout.assignments.filter(row => row.sectionId !== input.id);
      } else if (action === 'reorder') {
        const next = layout.sections.findIndex(row => row.id === input.beforeId);
        if (next < 0) throw invalid('Section does not exist.');
        const [section] = layout.sections.splice(index, 1);
        layout.sections.splice(next, 0, section);
      } else if (action === 'move') {
        if (!['up', 'down'].includes(String(input.direction))) throw invalid('Choose up or down.');
        const next = index + (input.direction === 'up' ? -1 : 1);
        if (next >= 0 && next < layout.sections.length) [layout.sections[index], layout.sections[next]] = [layout.sections[next], layout.sections[index]];
      } else throw invalid('Unknown layout action.');
    });
    return this.list(userId);
  },
};
