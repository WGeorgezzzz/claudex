export { messageQueueRoutes } from './message-queue.routes.js';
export { initializeMessageQueue, closeMessageQueue } from './message-queue.dispatcher.js';
// Session Bridge submits authenticated cross-session requests through the same durable queue.
export { messageQueueService } from '@/modules/message-queue/message-queue.service.js';
