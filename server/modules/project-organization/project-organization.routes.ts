import express from 'express';

import { AppError, asyncHandler, createApiSuccessResponse, requireAuthenticatedUserId } from '@/shared/index.js';

import { projectOrganizationService } from './project-organization.service.js';

/** Server composition mounts account-scoped navigation routes behind authentication. */
export const projectOrganizationRoutes=express.Router();
projectOrganizationRoutes.get('/',asyncHandler(async(req,res)=>{res.json(createApiSuccessResponse(projectOrganizationService.list(requireAuthenticatedUserId(req))));}));
projectOrganizationRoutes.patch('/',asyncHandler(async(req,res)=>{
  if(!req.body||typeof req.body!=='object'||Array.isArray(req.body))throw new AppError('Expected an object.',{statusCode:400});
  res.json(createApiSuccessResponse(projectOrganizationService.update(requireAuthenticatedUserId(req),req.body)));
}));
