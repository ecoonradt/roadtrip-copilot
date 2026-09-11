import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { routingRoutes, RoutingPluginOptions } from './routes/routing.js';
import { aiRoutes, AiPluginOptions } from './routes/ai.js';

export interface AppOptions extends RoutingPluginOptions, AiPluginOptions {
  logger?: boolean;
}

export function createApp(options: AppOptions = {}): FastifyInstance {
  const app = fastify({
    logger: options.logger ?? false,
  });

  // Enable CORS for local dev and frontends
  app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // Health check endpoint
  app.get('/api/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Register routing and geocoding proxy routes
  app.register(routingRoutes, {
    geocodeService: options.geocodeService,
    routeService: options.routeService,
  });

  // Register AI co-pilot generation routes
  app.register(aiRoutes, {
    aiService: options.aiService,
  });

  return app;
}

