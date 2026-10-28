import express from 'express';
import { requireSharedResourceAdministrator, isLocalRequest } from '@/modules/auth/index.js';
import { restartInstalledDesktop } from './desktop-restart.service.js';

import type { createSystemUpdateService } from './system.service.js';

/** Creates thin system routes that delegate update execution to the service. */
export function createSystemRouter(
  systemUpdateService: ReturnType<typeof createSystemUpdateService>,
): express.Router {
  const router = express.Router();
  router.post('/desktop/restart', requireSharedResourceAdministrator, (request,response,next)=>{
    if(!isLocalRequest(request)){response.status(403).json({error:'请在本地桌面窗口重启'});return;}
    try{response.status(202).json(restartInstalledDesktop());}catch(error){next(error);}
  });

  router.post('/update', requireSharedResourceAdministrator, async (_request, response, next) => {
    try {
      const result = await systemUpdateService.updateSystem();
      response.status(result.success ? 200 : 500).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
