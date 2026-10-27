import express from 'express';
import path from 'node:path';
import { z } from 'zod';
import { userContextMiddleware, requireContextUserId, authorizeProjectParameter, authorizePaths } from '@/modules/access-control/index.js';
import { projectsDb } from '@/modules/database/index.js';
import { taskmasterAutoService, taskmasterWorkspace } from './taskmaster-auto.service.js';

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
  router.get('/installation-status', action(() => ({ success: true, installation: { isInstalled: true, version: 'native' }, mcpServer: { hasMCPServer: false }, isReady: true })));
  router.get('/tasks/:projectId', action(req => taskmasterWorkspace.list(root(req), requireContextUserId())));
  router.post('/init/:projectId', action(async req => ({ projectId: req.params.projectId, ...await taskmasterWorkspace.initialize(root(req)) })));
  router.post('/add-task/:projectId', action(req => taskmasterWorkspace.add(root(req), req.body)));
  router.put('/update-task/:projectId/:taskId', action(req => taskmasterWorkspace.update(root(req), String(req.params.taskId), req.body)));
  router.post('/expand-task/:projectId/:taskId', action(req => taskmasterWorkspace.expand(root(req), String(req.params.taskId))));
  router.post('/parse-prd/:projectId', action(req => taskmasterAutoService.parsePrd(root(req), z.string().min(1).parse(req.body.fileName), requireContextUserId())));
  return router;
}
