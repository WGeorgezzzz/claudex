import { Router } from 'express';

import { getCurrentUserContext } from '@/modules/auth/index.js';

import { getQuotaService, resetQuotaService } from './quota.service.js';
import { readRelayConfiguration, saveRelayConfiguration } from './quota.config.js';

/** Server mounts this router behind authentication; query strings cannot override identity or role. */
export const quotaRoutes = Router();
quotaRoutes.get('/relay', (_req, res) => {
  if (getCurrentUserContext()?.role !== 'admin') { res.status(403).json({ error: 'Administrator required' }); return; }
  try { res.set('Cache-Control', 'no-store').json(readRelayConfiguration()); }
  catch { res.status(503).json({ error: '无法读取中转配置' }); }
});
quotaRoutes.put('/relay', (req, res) => {
  if (getCurrentUserContext()?.role !== 'admin') { res.status(403).json({ error: 'Administrator required' }); return; }
  if (typeof req.body?.baseUrl !== 'string') { res.status(400).json({ error: '中转地址必须是字符串' }); return; }
  try { const config = saveRelayConfiguration(req.body.baseUrl); resetQuotaService(); res.json(config); }
  catch { res.status(400).json({ error: '地址无效或由 NEXAGENT_RELAY_BASE_URL 管理' }); }
});
quotaRoutes.get('/', async (_req, res) => {
  const identity = getCurrentUserContext();
  if (!identity) { res.status(401).json({ error: 'Authentication required' }); return; }
  try { res.set('Cache-Control', 'no-store').json(await getQuotaService().overview(identity)); }
  catch { res.status(503).json({ error: '额度暂时不可用' }); }
});
