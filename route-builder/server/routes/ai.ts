import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { AiService, defaultAiService } from '../services/aiService.js';
import type { WaypointContext, AiEngineType, DayTitleContext } from '../types/ai.js';

export interface AiPluginOptions {
  aiService?: AiService;
}

interface GenerateBody {
  waypoint?: WaypointContext;
  waypoints?: WaypointContext[];
  apiKey?: string;
  preferredEngine?: AiEngineType | 'auto';
}

export const aiRoutes: FastifyPluginAsync<AiPluginOptions> = async (
  fastify: FastifyInstance,
  options: AiPluginOptions
) => {
  const aiService = options.aiService || defaultAiService;

  // POST /api/copilot/generate
  fastify.post<{ Body: GenerateBody }>(
    '/api/copilot/generate',
    async (request, reply) => {
      const { waypoint, waypoints, apiKey, preferredEngine } = request.body || {};

      // Validate that at least one of waypoint or waypoints is provided
      if (!waypoint && (!waypoints || !Array.isArray(waypoints) || waypoints.length === 0)) {
        return reply.status(400).send({
          error: 'Request body must contain either "waypoint" (object) or "waypoints" (non-empty array)',
        });
      }

      try {
        // Batch generation
        if (waypoints && Array.isArray(waypoints)) {
          const batchResult = await aiService.generateBatchAlerts(waypoints, {
            apiKey,
            preferredEngine,
          });
          return reply.status(200).send(batchResult);
        }

        // Single waypoint generation
        if (waypoint) {
          const singleResult = await aiService.generateAlert(waypoint, {
            apiKey,
            preferredEngine,
          });
          return reply.status(200).send(singleResult);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'AI generation error';
        fastify.log.error({ err }, `AI alert generation failed: ${message}`);
        return reply.status(500).send({ error: message });
      }
    }
  );

  // POST /api/copilot/day-title
  fastify.post<{ Body: Partial<DayTitleContext> & { apiKey?: string; preferredEngine?: AiEngineType | 'auto' } }>(
    '/api/copilot/day-title',
    async (request, reply) => {
      const { dayNumber, stops, apiKey, preferredEngine } = request.body || {};
      if (!Array.isArray(stops) || stops.length === 0) {
        return reply.status(400).send({ error: 'Request body must contain a non-empty "stops" array' });
      }
      try {
        const result = await aiService.generateDayTitle(
          { dayNumber: dayNumber ?? 1, stops },
          { apiKey, preferredEngine }
        );
        return reply.status(200).send(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Day title generation error';
        return reply.status(500).send({ error: message });
      }
    }
  );

  // GET /api/ai/status
  fastify.get<{ Querystring: { apiKey?: string } }>(
    '/api/ai/status',
    async (request, reply) => {
      const { apiKey } = request.query || {};
      const status = await aiService.getStatus(apiKey);
      return reply.status(200).send(status);
    }
  );

  // GET /api/ai/health (alias)
  fastify.get<{ Querystring: { apiKey?: string } }>(
    '/api/ai/health',
    async (request, reply) => {
      const { apiKey } = request.query || {};
      const status = await aiService.getStatus(apiKey);
      return reply.status(200).send({
        status: status.available ? 'ok' : 'unavailable',
        ...status,
      });
    }
  );
};
