import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ScoutService } from '../services/scoutService.js';
import type { ScoutChatRequest, ScoutScope } from '../types/scout.js';
import type { AiEngineType } from '../types/ai.js';

export interface ScoutPluginOptions {
  scoutService?: ScoutService;
}

interface ChatBody extends ScoutChatRequest {
  apiKey?: string;
  preferredEngine?: AiEngineType | 'auto';
}

interface QuickPromptsQuery {
  type?: 'day' | 'waypoint';
  dayNumber?: string;
  waypointId?: string;
  waypointName?: string;
}

export const scoutRoutes: FastifyPluginAsync<ScoutPluginOptions> = async (
  fastify: FastifyInstance,
  options: ScoutPluginOptions
) => {
  const scoutService = options.scoutService || new ScoutService();

  // POST /api/ai/scout/chat
  fastify.post<{ Body: ChatBody }>('/api/ai/scout/chat', async (request, reply) => {
    const { scope, messages, tripContext, sessionId, apiKey, preferredEngine } = request.body || {};

    if (!scope || !scope.type) {
      return reply.status(400).send({
        error: 'Request body must contain a valid "scope" object with "type" ("day" | "waypoint")',
      });
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return reply.status(400).send({
        error: 'Request body must contain a non-empty "messages" array',
      });
    }

    if (!tripContext || !Array.isArray(tripContext.waypoints)) {
      return reply.status(400).send({
        error: 'Request body must contain a valid "tripContext" object with "waypoints" array',
      });
    }

    try {
      const response = await scoutService.chat(
        { scope, messages, tripContext, sessionId },
        { apiKey, preferredEngine }
      );
      return reply.status(200).send(response);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Route Scout error';
      fastify.log.error({ err }, `Route Scout chat failed: ${message}`);
      return reply.status(500).send({ error: message });
    }
  });

  // GET /api/ai/scout/quick-prompts
  fastify.get<{ Querystring: QuickPromptsQuery }>('/api/ai/scout/quick-prompts', async (request, reply) => {
    const { type = 'day', dayNumber, waypointId, waypointName } = request.query || {};

    const scope: ScoutScope = {
      type: type === 'waypoint' ? 'waypoint' : 'day',
      dayNumber: dayNumber ? parseInt(dayNumber, 10) : undefined,
      waypointId,
      waypointName,
    };

    const prompts = scoutService.getQuickPrompts(scope);
    return reply.status(200).send({ prompts });
  });
};
