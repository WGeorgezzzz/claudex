import { Router } from 'express';
import { requireSharedResourceAdministrator } from '@/modules/auth/index.js';
import { AppError, asyncHandler } from '@/shared/index.js';
import { remoteAccessService } from './remote-access.service.js';

/** Composition mounts these thin admin-only Settings endpoints behind account authentication. */
export const remoteAccessRoutes = Router();
remoteAccessRoutes.use(requireSharedResourceAdministrator);
remoteAccessRoutes.get('/', asyncHandler(async (_req, res) => { res.set('Cache-Control', 'no-store').json(remoteAccessService.status()); }));
remoteAccessRoutes.post('/install', asyncHandler(async (_req, res) => { res.json(await remoteAccessService.install()); }));
remoteAccessRoutes.post('/login', asyncHandler(async (_req, res) => { res.json(remoteAccessService.login()); }));
remoteAccessRoutes.get('/tailscale', asyncHandler(async (_req, res) => { res.json(await remoteAccessService.tailscaleStatus()); }));
remoteAccessRoutes.post('/start', asyncHandler(async (req, res) => {
  const provider = req.body?.provider;
  if (!['devtunnel', 'cloudflare', 'tailscale-serve', 'tailscale-funnel'].includes(provider) || typeof req.body?.public !== 'boolean') throw new AppError('Invalid tunnel configuration', { statusCode: 400 });
  res.json(await remoteAccessService.start(provider, req.body.public));
}));
remoteAccessRoutes.post('/stop', asyncHandler(async (_req, res) => { res.json(remoteAccessService.stop()); }));
