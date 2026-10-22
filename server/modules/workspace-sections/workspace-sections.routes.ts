import express from 'express';

import { AppError, asyncHandler, createApiSuccessResponse, requireAuthenticatedUserId } from '@/shared/index.js';
import { workspaceSectionsService } from '@/modules/workspace-sections/workspace-sections.service.js';

/** Server composition mounts account-scoped sidebar section routes behind authentication. */
export const workspaceSectionsRoutes = express.Router();
workspaceSectionsRoutes.get('/', asyncHandler(async (req, res) => res.json(createApiSuccessResponse(workspaceSectionsService.list(requireAuthenticatedUserId(req))))));
workspaceSectionsRoutes.patch('/', asyncHandler(async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new AppError('Expected an object.', { statusCode: 400 });
  res.json(createApiSuccessResponse(workspaceSectionsService.update(requireAuthenticatedUserId(req), req.body)));
}));
