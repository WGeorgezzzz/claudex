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
sessionBridgeRoutes.post('/create', asyncHandler(async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || typeof req.body.sourceSessionId !== 'string') throw new AppError('A source conversation is required.', { statusCode: 400 });
  res.json(createApiSuccessResponse(sessionBridgeService.create(requireAuthenticatedUserId(req), req.body.sourceSessionId, req.body)));
}));
sessionBridgeRoutes.post('/fork', asyncHandler(async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || typeof req.body.sourceSessionId !== 'string') throw new AppError('A source conversation is required.', { statusCode: 400 });
  res.json(createApiSuccessResponse(await sessionBridgeService.fork(requireAuthenticatedUserId(req), req.body.sourceSessionId, req.body)));
}));
sessionBridgeRoutes.post('/wait', asyncHandler(async (req, res) => {
  res.json(createApiSuccessResponse(await sessionBridgeService.wait(requireAuthenticatedUserId(req), req.body ?? {})));
}));
sessionBridgeRoutes.post('/compact', asyncHandler(async (req, res) => {
  if (!req.body || typeof req.body.sourceSessionId !== 'string') throw new AppError('A source conversation is required.', { statusCode: 400 });
  res.json(createApiSuccessResponse(sessionBridgeService.compact(requireAuthenticatedUserId(req), req.body.sourceSessionId, req.body)));
}));
sessionBridgeRoutes.post('/archive', asyncHandler(async (req, res) => {
  if (!req.body || typeof req.body.sessionId !== 'string') throw new AppError('A session is required.', { statusCode: 400 });
  res.json(createApiSuccessResponse(sessionBridgeService.archive(requireAuthenticatedUserId(req), req.body.sessionId, true)));
}));
sessionBridgeRoutes.post('/unarchive', asyncHandler(async (req, res) => {
  if (!req.body || typeof req.body.sessionId !== 'string') throw new AppError('A session is required.', { statusCode: 400 });
  res.json(createApiSuccessResponse(sessionBridgeService.archive(requireAuthenticatedUserId(req), req.body.sessionId, false)));
}));
sessionBridgeRoutes.post('/rename', asyncHandler(async (req, res) => {
  if (!req.body || typeof req.body.sessionId !== 'string' || typeof req.body.title !== 'string') throw new AppError('A session and title are required.', { statusCode: 400 });
  res.json(createApiSuccessResponse(sessionBridgeService.rename(requireAuthenticatedUserId(req), req.body.sessionId, req.body.title)));
}));
sessionBridgeRoutes.get('/receipts/:id', asyncHandler(async (req, res) => res.json(createApiSuccessResponse(sessionBridgeService.status(requireAuthenticatedUserId(req), String(req.query.sourceSessionId ?? ''), String(req.params.id))))));
