import express from 'express';
import type { Request } from 'express';

import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';
import { monitorsService } from '@/modules/monitors/monitors.service.js';

function userId(req: Request): number {
  const id=Number((req as Request & {user?:{id?:string|number}}).user?.id);
  if(!Number.isInteger(id))throw new AppError('请先登录。',{code:'USER_REQUIRED',statusCode:401});
  return id;
}

/** Used by the server entrypoint behind its existing authentication middleware. */
export const monitorsRoutes=express.Router();
monitorsRoutes.get('/capabilities',asyncHandler(async(req,res)=>{
  userId(req);res.json(createApiSuccessResponse({calendar:true,scheduleVersion:1}));
}));
monitorsRoutes.get('/summaries',asyncHandler(async(req,res)=>{res.json(createApiSuccessResponse(monitorsService.summaries(userId(req))));}));
monitorsRoutes.get('/',asyncHandler(async(req,res)=>{
  res.json(createApiSuccessResponse(monitorsService.list(userId(req),typeof req.query.sessionId==='string'?req.query.sessionId:undefined)));
}));
monitorsRoutes.post('/',asyncHandler(async(req,res)=>{
  res.status(201).json(createApiSuccessResponse(monitorsService.create(userId(req),req.body??{})));
}));
monitorsRoutes.get('/:id/runs',asyncHandler(async(req,res)=>{
  res.json(createApiSuccessResponse(monitorsService.history(userId(req),String(req.params.id))));
}));
monitorsRoutes.post('/:id/action',asyncHandler(async(req,res)=>{
  res.json(createApiSuccessResponse(monitorsService.action(userId(req),String(req.params.id),req.body?.action)));
}));
monitorsRoutes.patch('/:id',asyncHandler(async(req,res)=>{
  const body=req.body??{};
  res.json(createApiSuccessResponse(monitorsService.update(userId(req),String(req.params.id),{
    name:body.name,content:body.content,intervalMinutes:body.intervalMinutes,schedule:body.schedule,
  })));
}));
