import express from 'express';
import { z } from 'zod';

import { asyncHandler, createApiSuccessResponse, requireAuthenticatedUserId } from '@/shared/index.js';
import { dotService } from '@/modules/dot/dot.service.js';

/** Server composition mounts Dot behind the normal authenticated API boundary. */
export const dotRoutes=express.Router();
dotRoutes.get('/',asyncHandler(async(req,res)=>res.json(createApiSuccessResponse(dotService.snapshot(requireAuthenticatedUserId(req))))));
dotRoutes.post('/threads',asyncHandler(async(req,res)=>{const body=z.object({title:z.string().max(200).default('Dot · 新对话')}).parse(req.body);res.json(createApiSuccessResponse(dotService.createThread(requireAuthenticatedUserId(req),body.title)));}));
dotRoutes.post('/memories',asyncHandler(async(req,res)=>{const b=z.object({content:z.string().min(1).max(4000),id:z.string().optional(),revision:z.number().int().nonnegative().optional()}).parse(req.body);res.json(createApiSuccessResponse(dotService.saveMemory(requireAuthenticatedUserId(req),b.content,b.id,b.revision)));}));
dotRoutes.delete('/memories/:id',asyncHandler(async(req,res)=>{const b=z.object({revision:z.number().int().nonnegative()}).parse(req.body);res.json(createApiSuccessResponse(dotService.forget(requireAuthenticatedUserId(req),String(req.params.id),b.revision)));}));
dotRoutes.post('/tasks/:id/cancel',asyncHandler(async(req,res)=>res.json(createApiSuccessResponse(dotService.cancelPending(requireAuthenticatedUserId(req),String(req.params.id))))));
