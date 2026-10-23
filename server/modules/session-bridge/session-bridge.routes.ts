import express from 'express';

import { AppError, asyncHandler, createApiSuccessResponse, requireAuthenticatedUserId } from '@/shared/index.js';
import { sessionBridgeService } from '@/modules/session-bridge/session-bridge.service.js';

/** Server composition mounts cross-session reads and explicit sends behind the existing account authentication. */
export const sessionBridgeRoutes = express.Router();
sessionBridgeRoutes.get('/sessions', asyncHandler(async (req, res) => res.json(createApiSuccessResponse(sessionBridgeService.list(String(req.query.query ?? ''), Number(req.query.offset ?? 0), requireAuthenticatedUserId(req))))));
sessionBridgeRoutes.get('/sessions/:id', asyncHandler(async (req, res) => res.json(createApiSuccessResponse(await sessionBridgeService.read(String(req.params.id), Number(req.query.offset ?? 0), requireAuthenticatedUserId(req))))));
sessionBridgeRoutes.post('/send', asyncHandler(async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || typeof req.body.sourceSessionId !== 'string') throw new AppError('A source conversation is required.', { statusCode: 400 });
  res.json(createApiSuccessResponse(sessionBridgeService.send(requireAuthenticatedUserId(req), req.body.sourceSessionId, req.body)));
}));
sessionBridgeRoutes.get('/receipts/:id', asyncHandler(async (req, res) => res.json(createApiSuccessResponse(sessionBridgeService.status(requireAuthenticatedUserId(req), String(req.query.sourceSessionId ?? ''), String(req.params.id))))));
