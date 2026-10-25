import { Router } from 'express';

import { getCurrentUserContext } from '@/modules/auth/index.js';

import { getQuotaService } from './quota.service.js';

/** Server mounts this router behind authentication; query strings cannot override identity or role. */
export const quotaRoutes = Router();
quotaRoutes.get('/', async (_req, res) => {
  const identity = getCurrentUserContext();
  if (!identity) { res.status(401).json({ error: 'Authentication required' }); return; }
  try { res.set('Cache-Control', 'no-store').json(await getQuotaService().overview(identity)); }
  catch { res.status(503).json({ error: '额度暂时不可用' }); }
});
