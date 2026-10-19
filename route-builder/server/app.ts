import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import { routingRoutes, RoutingPluginOptions } from './routes/routing.js';
import { aiRoutes, AiPluginOptions } from './routes/ai.js';
import { scoutRoutes, ScoutPluginOptions } from './routes/scout.js';
import { deviceRoutes, DevicePluginOptions } from './routes/device.js';
import { itineraryRoutes, ItineraryPluginOptions } from './routes/itineraries.js';
import { authRoutes, AuthPluginOptions } from './routes/auth.js';
import { AuthService } from './services/authService.js';
import { createAuthGuard } from './hooks/authGuard.js';

export interface AppOptions
  extends RoutingPluginOptions,
    AiPluginOptions,
    ScoutPluginOptions,
    DevicePluginOptions,
    ItineraryPluginOptions,
    AuthPluginOptions {
  logger?: boolean;
}

export function createApp(options: AppOptions = {}): FastifyInstance {
  const app = fastify({
    logger: options.logger ?? false,
  });

  const authService = options.authService ?? new AuthService();

  // Register cookie parser
  app.register(cookie);

  // Register JWT plugin with fallback secret for local dev
  app.register(jwt, {
    secret: process.env.JWT_SECRET || 'dev-insecure-jwt-secret-roadtrip-copilot',
  });

  // Enable CORS for local dev and frontends
  app.register(cors, {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // Register auth guard hook for /api/*
  app.addHook('preHandler', createAuthGuard(authService));

  // Health check endpoint
  app.get('/api/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Register auth routes
  app.register(authRoutes, {
    authService,
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

  // Register Route Scout conversational routes
  app.register(scoutRoutes, {
    scoutService: options.scoutService,
  });

  // Register device and handoff routes
  app.register(deviceRoutes, {
    deviceService: options.deviceService,
  });

  // Register itinerary storage and discovery routes
  app.register(itineraryRoutes, {
    storageService: options.storageService,
  });

  return app;
}
