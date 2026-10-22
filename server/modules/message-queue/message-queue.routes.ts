import express from 'express';

import { requireAuthenticatedUserId } from '@/shared/index.js';
import { asyncHandler, createApiSuccessResponse, AppError } from '@/shared/utils.js';
import { messageQueueService } from '@/modules/message-queue/message-queue.service.js';
import { liveInputService } from '@/modules/message-queue/live-input.service.js';

/** Server composition mounts the queue transport behind authentication. */
export const messageQueueRoutes=express.Router();
messageQueueRoutes.get('/live',asyncHandler(async(req,res)=>{
  res.json(createApiSuccessResponse(liveInputService.current(typeof req.query.sessionId==='string'?req.query.sessionId:'')));
}));
messageQueueRoutes.post('/live',asyncHandler(async(req,res)=>{
  if (!req.body || typeof req.body!=='object' || Array.isArray(req.body)) throw new AppError('Expected an object.',{statusCode:400});
  res.json(createApiSuccessResponse(liveInputService.submit(requireAuthenticatedUserId(req),req.body)));
}));
messageQueueRoutes.get('/',asyncHandler(async(req,res)=>{
  res.json(createApiSuccessResponse(messageQueueService.list(requireAuthenticatedUserId(req),typeof req.query.sessionId==='string'?req.query.sessionId:'')));
}));
messageQueueRoutes.post('/',asyncHandler(async(req,res)=>{
  if (!req.body || typeof req.body!=='object' || Array.isArray(req.body)) throw new AppError('Expected an object.',{statusCode:400});
  res.status(201).json(createApiSuccessResponse(messageQueueService.enqueue(requireAuthenticatedUserId(req),req.body)));
}));
messageQueueRoutes.patch('/:id',asyncHandler(async(req,res)=>{
  if (!req.body || typeof req.body!=='object' || Array.isArray(req.body)) throw new AppError('Expected an object.',{statusCode:400});
  res.json(createApiSuccessResponse(messageQueueService.update(requireAuthenticatedUserId(req),String(req.params.id),req.body)));
}));
messageQueueRoutes.get('/:id/attempts',asyncHandler(async(req,res)=>{
  res.json(createApiSuccessResponse(messageQueueService.attempts(requireAuthenticatedUserId(req),String(req.params.id))));
}));
