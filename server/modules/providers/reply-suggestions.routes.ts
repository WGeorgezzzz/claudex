import express from 'express';

import { requireContextUserId } from '@/modules/access-control/index.js';
import { replySuggestionsService } from '@/modules/providers/services/reply-suggestions.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

/** Mounted inside the authenticated Providers router, including bounded hot activation during live runs. */
export const replySuggestionsRouter = express.Router();
replySuggestionsRouter.post('/sessions/:sessionId/reply-suggestions', asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const expectedReply = req.body?.expectedReply;
  if (typeof sessionId !== 'string' || sessionId.length > 200 || typeof expectedReply !== 'string' || !expectedReply.trim() || expectedReply.length > 2000) {
    throw new AppError('Invalid reply suggestion request.', { statusCode: 400 });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(createApiSuccessResponse(await replySuggestionsService.get(requireContextUserId(), sessionId, expectedReply)));
}));
