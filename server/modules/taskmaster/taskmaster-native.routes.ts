import express from 'express';
import path from 'node:path';
import { z } from 'zod';
import { userContextMiddleware, requireContextUserId, authorizeProjectParameter, authorizePaths } from '@/modules/access-control/index.js';
import { projectsDb } from '@/modules/database/index.js';
import { requireSharedResourceAdministrator } from '@/modules/auth/index.js';
import { inboxBatchSchema, taskmasterInboxService } from './taskmaster-inbox.service.js';
import { taskmasterAutoService, taskmasterWorkspace } from './taskmaster-auto.service.js';
import { taskIntelligenceService } from './taskmaster-intelligence.service.js';

/** TaskMaster composition mounts these native endpoints ahead of legacy document routes. */
export function createTaskmasterNativeRouter() {
  const router = express.Router(); router.use(userContextMiddleware);
  router.param('projectId', authorizeProjectParameter(projectsDb.getProjectPathById));
  router.param('projectId', (req, res, next, id) => authorizePaths(() => {
    const project = projectsDb.getProjectPathById(String(id));
    return project ? ['.taskmaster', '.taskmaster/config.json', '.taskmaster/state.json', '.taskmaster/tasks', '.taskmaster/tasks/tasks.json', '.taskmaster/docs', '.taskmaster/reports'].map(p => path.join(project, p)) : [];
  })(req, res, next));
  const action = (run: (req: express.Request) => unknown) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve().then(() => run(req)).then(data => res.json(data)).catch(error => {
      if (error instanceof z.ZodError) { res.status(400).json({ message: '参数格式不正确。' }); return; } next(error);
    });
  };
  router.get('/auto/settings', action(() => taskmasterAutoService.settings()));
  router.put('/auto/settings', action(req => taskmasterAutoService.saveSettings(req.body)));
  router.get('/auto/sessions/:sessionId', action(req => taskmasterAutoService.snapshot(String(req.params.sessionId))));
  router.post('/auto/sessions/:sessionId/extract', action(req => taskmasterAutoService.extract(String(req.params.sessionId))));
  router.post('/auto/sessions/:sessionId/confirm', action(req => taskmasterAutoService.extract(String(req.params.sessionId), true)));
  router.post('/auto/sessions/:sessionId/undo', action(req => taskmasterAutoService.undo(String(req.params.sessionId), z.string().uuid().parse(req.body.auditId))));
  const root = (req: express.Request) => projectsDb.getProjectPathById(String(req.params.projectId))!;
  router.use('/inbox', requireSharedResourceAdministrator);
  const executionSettings=z.object({provider:z.enum(['claude','codex','gemini','deepseek-harness']).optional(),model:z.string().max(200).optional(),effort:z.string().max(40).optional(),permissionMode:z.string().max(40).optional(),cwd:z.string().max(4096).optional()}).strict();
  const execution = z.object({ projectId: z.string().min(1), taskId: z.string().min(1), option: z.enum(['A', 'B', 'C']).optional(), userInput: z.string().max(10000).optional(),settings:executionSettings.optional() });
  router.post('/inbox/import', action(req => process.env.NEXAGENT_LEGACY_TODO_SYNC==='1'?taskmasterInboxService.import(inboxBatchSchema.parse(req.body)):{disabled:true,tasks:[],auditId:null,note:'飞书桥接待办同步已关闭；请在信息看板整理待办。'}));
  router.post('/inbox/sync',action(()=>taskmasterInboxService.syncInfohub()));
  router.get('/inbox/execution-settings',action(()=>taskmasterInboxService.executionSettings()));
  router.get('/inbox/session-source/:sessionId',action(req=>taskmasterInboxService.sessionSource(String(req.params.sessionId))));
  router.get('/inbox/global', action(() => taskmasterInboxService.global()));
  router.post('/inbox/intelligence/execute',action(req=>taskIntelligenceService.executeWithContext(z.object({id:z.string().min(1),parent:z.boolean().default(false),settings:executionSettings.optional()}).parse(req.body))));
  router.get('/inbox/intelligence',action(()=>taskIntelligenceService.snapshot()));
  router.post('/inbox/intelligence/refresh',action(req=>taskIntelligenceService.asyncStart(req.body?.force===true)));
  router.post('/inbox/intelligence/correct',action(req=>taskIntelligenceService.correct(req.body)));
  router.post('/inbox/organize', action(req=>taskmasterInboxService.organize(z.string().min(1).parse(req.body.projectId))));
  router.post('/inbox/unit', action(req=>{const p=z.object({projectId:z.string().min(1),id:z.string().min(1).max(200),title:z.string().min(1).max(300).optional(),parentIds:z.array(z.string().min(1).max(200)).max(30),tags:z.array(z.string().regex(/^[a-z]+:.+/).max(150)).max(50).optional()}).parse(req.body);return taskmasterInboxService.linkUnit(p.projectId,p);}));
  router.get('/inbox/views',action(()=>taskmasterInboxService.views()));
  router.put('/inbox/views',action(req=>taskmasterInboxService.saveViews(z.array(z.object({name:z.string().min(1).max(80),tags:z.array(z.string().max(150)).max(30),projectId:z.string().max(200),view:z.enum(['all','today','mine','explore'])})).max(30).parse(req.body))));
  router.post('/inbox/create', action(req => taskmasterInboxService.create(z.string().min(1).parse(req.body.projectId), z.object({ title: z.string().min(1).max(300), priority: z.enum(['high', 'medium', 'low']).optional() }).parse(req.body))));
  router.post('/inbox/input', action(req => { const p = z.object({ projectId: z.string().min(1), taskId: z.string().min(1), userInput: z.string().max(10000) }).parse(req.body); return taskmasterInboxService.saveInput(p.projectId, p.taskId, p.userInput); }));
  router.get('/inbox/status', action(req => taskmasterInboxService.status(z.string().min(1).parse(req.query.projectId))));
  router.post('/inbox/execute', action(req => { const p = execution.parse(req.body); return taskmasterInboxService.execute(p.projectId, p.taskId, p.option, p.userInput,p.settings); }));
  router.post('/inbox/action', action(req => { const p = execution.extend({ action: z.enum(['done', 'cancelled']) }).parse(req.body); return taskmasterInboxService.action(p.projectId, p.taskId, p.action); }));
  router.post('/inbox/undo', action(req => { const p = z.object({ projectId: z.string().min(1), auditId: z.string().uuid() }).parse(req.body); return taskmasterInboxService.undo(p.projectId, p.auditId); }));
  router.post('/inbox/test-cleanup', action(req => { const p = execution.extend({ title: z.string().min(1) }).parse(req.body); return taskmasterInboxService.cleanup(p.projectId, p.taskId, p.title); }));
  router.get('/installation-status', action(() => ({ success: true, installation: { isInstalled: true, version: 'native' }, mcpServer: { hasMCPServer: false }, isReady: true })));
  router.get('/tasks/:projectId', action(req => taskmasterWorkspace.list(root(req), requireContextUserId())));
  router.post('/init/:projectId', action(async req => ({ projectId: req.params.projectId, ...await taskmasterWorkspace.initialize(root(req)) })));
  router.post('/add-task/:projectId', action(req => taskmasterWorkspace.add(root(req), req.body)));
  router.put('/update-task/:projectId/:taskId', action(req => taskmasterWorkspace.update(root(req), String(req.params.taskId), req.body)));
  router.post('/expand-task/:projectId/:taskId', action(req => taskmasterWorkspace.expand(root(req), String(req.params.taskId))));
  router.post('/parse-prd/:projectId', action(req => taskmasterAutoService.parsePrd(root(req), z.string().min(1).parse(req.body.fileName), requireContextUserId())));
  return router;
}
