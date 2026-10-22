import express from 'express';
import { requireAuthenticatedUserId } from '@/shared/index.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import { sessionWorkspaceService } from '@/modules/session-workspace/session-workspace.service.js';

/** Server composition mounts authenticated organization and dispatch-control routes. */
export const sessionWorkspaceRoutes=express.Router();
sessionWorkspaceRoutes.get('/',asyncHandler(async(req,res)=>res.json(createApiSuccessResponse(sessionWorkspaceService.list(requireAuthenticatedUserId(req))))));
sessionWorkspaceRoutes.get('/:id',asyncHandler(async(req,res)=>res.json(createApiSuccessResponse(sessionWorkspaceService.get(requireAuthenticatedUserId(req),String(req.params.id))))));
sessionWorkspaceRoutes.patch('/:id',asyncHandler(async(req,res)=>{
  if(!req.body||typeof req.body!=='object'||Array.isArray(req.body))throw new AppError('Expected an object.',{statusCode:400});
  res.json(createApiSuccessResponse(sessionWorkspaceService.update(requireAuthenticatedUserId(req),String(req.params.id),req.body)));
}));
