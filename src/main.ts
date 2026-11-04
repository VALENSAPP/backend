import * as dns from 'node:dns';
dns.setDefaultResultOrder?.('ipv4first');

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupSwagger } from './swagger/swagger.config';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { I18nExceptionFilter } from './common/filters/i18n-exception.filter';
import { I18nService } from 'nestjs-i18n';
import * as bodyParser from 'body-parser';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { Server, Socket } from 'socket.io';
import { PostService } from './post/post.service';
import { ClosetChatService } from './marketPlace/closet-chat/closet-chat.service';
import { createRateLimitMiddleware } from './common/rate-limit.middleware';
import type { NextFunction, Request, Response } from 'express';
const basicAuth = require('express-basic-auth');

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.disable('x-powered-by');


  // Get PostService instance
  const postService = app.get(PostService);
  const closetChatService = app.get(ClosetChatService);

  // Webhooks need raw body for signature verification
  app.use('/billing/webhook', bodyParser.raw({ type: '*/*' }));
  // app.use('/billing/pagbank/webhook', bodyParser.raw({ type: '*/*' }));
  app.use('/kyc/webhook', bodyParser.raw({ type: '*/*' }));
  app.use('/sumsub-verification/webhook', bodyParser.raw({ type: '*/*' }));
  app.use('/sumsub-user_verification/webhook', bodyParser.raw({ type: '*/*' }));
  app.use('/shipping/easypost/webhook', bodyParser.raw({ type: '*/*' }));
  app.use(bodyParser.json({ limit: '5mb' }));
  app.use(bodyParser.urlencoded({ extended: true }));

  // Rate limit auth endpoints (basic brute-force protection)
  app.use(
    '/auth/login',
    createRateLimitMiddleware({
      windowMs: 15 * 60 * 1000,
      max: 30,
    }),
  );
  app.use(
    '/auth/refresh',
    createRateLimitMiddleware({
      windowMs: 15 * 60 * 1000,
      max: 60,
    }),
  );
  app.use(
    '/auth/forgot-password',
    createRateLimitMiddleware({
      windowMs: 15 * 60 * 1000,
      max: 5,
    }),
  );
  app.use(
    '/user/forgot-password',
    createRateLimitMiddleware({
      windowMs: 15 * 60 * 1000,
      max: 5,
    }),
  );

  const applyMethodRateLimit = (
    path: string,
    methods: Array<'POST' | 'PATCH' | 'PUT' | 'DELETE'>,
    options: { windowMs: number; max: number },
  ) => {
    const limiter = createRateLimitMiddleware(options);
    app.use(path, (req: Request, res: Response, next: NextFunction) => {
      if (!methods.includes(req.method as any)) {
        return next();
      }
      return limiter(req, res, next);
    });
  };

  // Marketplace Battle abuse protection (reuse existing limiter, do not affect workers/webhooks).
  applyMethodRateLimit('/marketplace-battles', ['POST'], { windowMs: 60 * 1000, max: 20 });
  applyMethodRateLimit('/marketplace-battles/:battleId', ['PATCH', 'DELETE'], {
    windowMs: 60 * 1000,
    max: 30,
  });
  applyMethodRateLimit('/marketplace-battles/:battleId/publish', ['POST'], {
    windowMs: 60 * 1000,
    max: 20,
  });
  applyMethodRateLimit('/marketplace-battles/:battleId/challenge', ['POST'], {
    windowMs: 60 * 1000,
    max: 20,
  });
  applyMethodRateLimit('/marketplace-battles/:battleId/cancel', ['POST'], {
    windowMs: 60 * 1000,
    max: 20,
  });
  applyMethodRateLimit('/marketplace-battles/:battleId/vote', ['POST', 'DELETE'], {
    windowMs: 60 * 1000,
    max: 120,
  });
  applyMethodRateLimit('/marketplace-battles/:battleId/view', ['POST'], {
    windowMs: 60 * 1000,
    max: 120,
  });
  applyMethodRateLimit('/marketplace-battles/:battleId/comments', ['POST'], {
    windowMs: 60 * 1000,
    max: 120,
  });
  applyMethodRateLimit('/marketplace-battles/:battleId/comments/:commentId', ['DELETE'], {
    windowMs: 60 * 1000,
    max: 120,
  });
  applyMethodRateLimit('/marketplace-battles/:battleId/boosts', ['POST'], {
    windowMs: 60 * 1000,
    max: 30,
  });
  applyMethodRateLimit('/marketplace-battle-boosts/:boostId/payment', ['POST'], {
    windowMs: 60 * 1000,
    max: 30,
  });
  applyMethodRateLimit('/postshare/:id/donate', ['POST'], {
    windowMs: 60 * 1000,
    max: 20,
  });

  // Serve static files from the public directory
  app.useStaticAssets(join(__dirname, '..', 'public'));

  // Serve .well-known files with correct content type
  app.useStaticAssets(join(__dirname, '..', 'public', '.well-known'), {
    prefix: '/.well-known/',
    setHeaders: (res, path) => {
      if (path.endsWith('apple-app-site-association')) {
        res.setHeader('Content-Type', 'application/json');
      }
    }
  });

  const i18nService = app.get(I18nService);
  app.useGlobalInterceptors(new ResponseInterceptor(i18nService));
  app.useGlobalFilters(new I18nExceptionFilter(i18nService));

  const swaggerUsername = process.env.SWAGGER_USERNAME;
  const swaggerPassword = process.env.SWAGGER_PASSWORD;

  if (!swaggerUsername || !swaggerPassword) {
    throw new Error('SWAGGER_USERNAME and SWAGGER_PASSWORD must be set to protect Swagger.');
  }

  app.use(
    '/api',
    basicAuth({
      users: {
        [swaggerUsername]: swaggerPassword,
      },
      challenge: true,
    }),
  );

  setupSwagger(app);

  const port = process.env.PORT || 3002;
  const host = process.env.HOST || '0.0.0.0';

  // Start HTTP server
  await app.listen(port, host);

  // Initialize Socket.IO server
  const io = new Server(app.getHttpServer(), {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  // Socket.IO connection handling
  const connectedUsers = new Map<string, string>(); // userId -> socketId

  io.on('connection', (socket: Socket) => {
    const userId = socket.handshake.query.userId as string;
    // console.log(`User ${userId} connected with socket ${socket.id}`);

    if (userId) {
      connectedUsers.set(userId, socket.id);
    }

    // Handle getUserChatBox
    socket.on('getUserChatBox', async (data: any) => {
      try {
        // FIX: parse JSON string if necessary
        if (typeof data === 'string') {
          data = JSON.parse(data);
        }

        // console.log('getUserChatBox payload:', data, data.userId);

        const userId = data.userId;

        const chatBoxes = await postService.getUserChatBox(userId);
        socket.emit('userChatBox', chatBoxes);
      } catch (error) {
        console.error('getUserChatBox error:', error);
        socket.emit('userChatBoxError', { message: 'Failed to fetch chat boxes' });
      }
    });

    socket.on('getConversation', async (data: any) => {
      try {
        // FIX: parse JSON string if necessary
        if (typeof data === 'string') {
          data = JSON.parse(data);
        }

        // console.log('getConversationWithUser payload:', data, data.userId);

        const userId = data.userId;
        const otherUserId = data.otherUserId;

        const chatBoxes = await postService.getConversationWithUser(userId, otherUserId);
        socket.emit('userConversation', chatBoxes);
      } catch (error) {
        console.error('getUserConversation error:', error);
        socket.emit('userConversation', { message: 'Failed to fetch conversation' });
      }
    });

    // Mark a single message as seen
    socket.on('markMessageSeen', async (data: any) => {
      try {
        if (typeof data === 'string') {
          data = JSON.parse(data);
        }

        const { messageId, userId, otherUserId } = data || {};

        if (!messageId) {
          socket.emit('messageSeenError', { message: 'messageId required' });
          return;
        }

        const result = await postService.messageSeenUpdate(messageId, userId);
        socket.emit('messageSeen', { messageId, ...result });

        // Notify the other user if connected
        if (otherUserId) {
          const otherSocketId = connectedUsers.get(otherUserId);
          if (otherSocketId) {
            io.to(otherSocketId).emit('messageSeen', { messageId, seenBy: userId, ...result });
          }
        }
      } catch (error) {
        console.error('markMessageSeen error:', error);
        socket.emit('messageSeenError', { message: 'Failed to update seen status' });
      }
    });

    socket.on('getClosetChatThreads', async (data: any) => {
      try {
        if (typeof data === 'string') {
          data = JSON.parse(data);
        }

        const userId = data?.userId;
        const threads = await closetChatService.getMyThreads(userId);
        socket.emit('closetChatThreads', threads);
      } catch (error) {
        console.error('getClosetChatThreads error:', error);
        socket.emit('closetChatThreadsError', { message: 'Failed to fetch closet chat threads' });
      }
    });

    socket.on('getClosetChatMessages', async (data: any) => {
      try {
        if (typeof data === 'string') {
          data = JSON.parse(data);
        }

        const userId = data?.userId;
        const threadId = data?.threadId;
        const page = data?.page;
        const limit = data?.limit;

        if (!threadId) {
          socket.emit('closetChatMessagesError', { message: 'threadId required' });
          return;
        }

        const result = await closetChatService.getThreadMessages(userId, threadId, page, limit);
        socket.emit('closetChatMessages', result);
      } catch (error) {
        console.error('getClosetChatMessages error:', error);
        socket.emit('closetChatMessagesError', { message: 'Failed to fetch closet chat messages' });
      }
    });

    socket.on('sendClosetChatMessage', async (data: any) => {
      try {
        if (typeof data === 'string') {
          data = JSON.parse(data);
        }

        const userId = data?.userId;
        const threadId = data?.threadId;
        const message = data?.message;

        if (!threadId) {
          socket.emit('closetChatSendError', { message: 'threadId required' });
          return;
        }

        if (!message || !String(message).trim()) {
          socket.emit('closetChatSendError', { message: 'message required' });
          return;
        }

        const createdMessage = await closetChatService.sendMessage(userId, threadId, String(message));
        socket.emit('closetChatMessageSent', createdMessage);

        const receiverSocketId = connectedUsers.get(createdMessage.receiverId);
        if (receiverSocketId) {
          io.to(receiverSocketId).emit('closetChatNewMessage', createdMessage);
        }

        const senderThreads = await closetChatService.getMyThreads(userId);
        socket.emit('closetChatThreads', senderThreads);

        if (receiverSocketId) {
          const receiverThreads = await closetChatService.getMyThreads(createdMessage.receiverId);
          io.to(receiverSocketId).emit('closetChatThreads', receiverThreads);
        }
      } catch (error) {
        console.error('sendClosetChatMessage error:', error);
        socket.emit('closetChatSendError', { message: 'Failed to send closet chat message' });
      }
    });

    socket.on('markClosetChatMessageSeen', async (data: any) => {
      try {
        if (typeof data === 'string') {
          data = JSON.parse(data);
        }

        const userId = data?.userId;
        const messageId = data?.messageId;

        if (!messageId) {
          socket.emit('closetChatMessageSeenError', { message: 'messageId required' });
          return;
        }

        const result = await closetChatService.markMessageSeen(userId, messageId);
        socket.emit('closetChatMessageSeen', { messageId, ...result });

        if (result?.otherUserId) {
          const otherSocketId = connectedUsers.get(result.otherUserId);
          if (otherSocketId) {
            io.to(otherSocketId).emit('closetChatMessageSeen', {
              messageId,
              seenBy: userId,
              ...result,
            });
          }
        }
      } catch (error) {
        console.error('markClosetChatMessageSeen error:', error);
        socket.emit('closetChatMessageSeenError', { message: 'Failed to update closet chat seen status' });
      }
    });


    // Handle disconnect
    socket.on('disconnect', () => {
      if (userId) {
        connectedUsers.delete(userId);
        // console.log(`User ${userId} disconnected`);
      }
    });
  });

  console.log(`Nest application successfully started`);
  console.log(`Listening on host "${host}" at port "${port}"`);
  console.log(`Socket.IO server running on the same port`);
  console.log(`Access Swagger UI at "https://api.valens.app/api"`);
  // Local Stripe testing: run in another terminal: stripe listen --forward-to localhost:${port}/billing/webhook
  console.log(`[Stripe] For local webhooks run: stripe listen --forward-to http://localhost:${port}/billing/webhook`);
  console.log(`[EasyPost] Webhook endpoint: http://localhost:${port}/shipping/easypost/webhook (set EASYPOST_API_KEY when ready)`);
}
bootstrap();
