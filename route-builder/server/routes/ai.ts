import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { AiService, defaultAiService } from '../services/aiService.js';
import type { WaypointContext, AiEngineType } from '../types/ai.js';

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
};
