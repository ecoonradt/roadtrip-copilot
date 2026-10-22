import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ScoutService } from '../services/scoutService.js';
import { InvalidModelError } from '../services/bedrockService.js';
import type { ScoutChatRequest, ScoutScope } from '../types/scout.js';
import type { AiEngineType } from '../types/ai.js';

export interface ScoutPluginOptions {
  scoutService?: ScoutService;
  keepAliveIntervalMs?: number;
}

interface ChatBody extends ScoutChatRequest {
  apiKey?: string;
  preferredEngine?: AiEngineType | 'auto';
  modelId?: string;
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
    const { scope, messages, tripContext, sessionId, apiKey, preferredEngine, modelId } = request.body || {};

    if (modelId !== undefined && modelId !== null) {
      try {
        scoutService.validateModelId(modelId);
      } catch (err: unknown) {
        if (err instanceof InvalidModelError || (err as { statusCode?: number })?.statusCode === 400) {
          return reply.status(400).send({ error: (err as Error).message });
        }
        throw err;
      }
    }

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
        { scope, messages, tripContext, sessionId, modelId },
        { apiKey, preferredEngine, modelId }
      );
      return reply.status(200).send(response);
    } catch (err: unknown) {
      if (err instanceof InvalidModelError || (err as { statusCode?: number })?.statusCode === 400) {
        return reply.status(400).send({ error: (err as Error).message });
      }
      const message = err instanceof Error ? err.message : 'Route Scout error';
      fastify.log.error({ err }, `Route Scout chat failed: ${message}`);
      return reply.status(500).send({ error: message });
    }
  });

  // POST /api/ai/scout/chat/stream (SSE streaming)
  fastify.post<{ Body: ChatBody }>('/api/ai/scout/chat/stream', async (request, reply) => {
    const { scope, messages, tripContext, sessionId, apiKey, preferredEngine, modelId } = request.body || {};

    if (modelId !== undefined && modelId !== null) {
      try {
        scoutService.validateModelId(modelId);
      } catch (err: unknown) {
        if (err instanceof InvalidModelError || (err as { statusCode?: number })?.statusCode === 400) {
          return reply.status(400).send({ error: (err as Error).message });
        }
        throw err;
      }
    }

    if (!scope || !scope.type || !Array.isArray(messages) || messages.length === 0 || !tripContext) {
      return reply.status(400).send({
        error: 'Invalid request payload for Scout chat stream',
      });
    }

    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders?.();
    reply.raw.write(': ping\n\n');

    let streamClosed = false;
    const abortController = new AbortController();

    const keepAliveTimer = setInterval(() => {
      if (!streamClosed && !reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.write(': keep-alive\n\n');
      }
    }, options.keepAliveIntervalMs ?? 15_000);

    const onClose = () => {
      streamClosed = true;
      clearInterval(keepAliveTimer);
      abortController.abort();
    };
    reply.raw.on('close', onClose);

    const sendEvent = (event: string, data: unknown) => {
      if (!streamClosed && !reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    try {
      await scoutService.chatStream(
        { scope, messages, tripContext, sessionId, modelId },
        (streamEvent) => {
          sendEvent(streamEvent.event, streamEvent.data);
        },
        { apiKey, preferredEngine, modelId, abortSignal: abortController.signal }
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Route Scout streaming error';
      fastify.log.error({ err }, `Route Scout stream failed: ${message}`);
      sendEvent('error', { error: message });
    } finally {
      streamClosed = true;
      clearInterval(keepAliveTimer);
      reply.raw.removeListener('close', onClose);
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    }
    return reply;
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
