import { Router } from 'express';

import { getConnection } from '@/modules/database/index.js';
import { getCurrentUserContext } from '@/modules/auth/index.js';

import { rescanUsage, usageOverview } from './usage.service.js';

/** Server entrypoint mounts this router behind authentication; identity always comes from its trusted context. */
export const usageRoutes = Router();
usageRoutes.get('/overview', (req,res) => {
  const context=getCurrentUserContext();
  if(!context){res.status(401).json({error:'Authentication required'});return;}
  const range=String(req.query.range||'30d'),group=String(req.query.groupBy||'user');
  const userId=req.query.userId===undefined?undefined:Number(req.query.userId);
  if(!['24h','7d','30d','90d'].includes(range)||!['user','provider','model'].includes(group)||(context.role==='admin' && userId!==undefined && (!Number.isSafeInteger(userId)||userId<1))){res.status(400).json({error:'Invalid usage query'});return;}
  res.json(usageOverview(getConnection(),{id:context.userId,role:context.role},range,group,userId));
});
usageRoutes.post('/rescan', (_req,res) => {
  if(getCurrentUserContext()?.role!=='admin'){res.status(403).json({error:'Administrator required'});return;}
  void rescanUsage().catch(e=>console.error('[Usage] Manual scan failed',e));
  res.status(202).json({scanning:true});
});
