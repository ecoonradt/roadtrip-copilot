import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ScoutService } from '../services/scoutService.js';
import { InvalidModelError, UnknownAiProviderError } from '../services/aiService.js';
import { MalformedAiResponseError } from '../services/schemaParser.js';
import type { ScoutChatRequest, ScoutScope } from '../types/scout.js';

export interface ScoutPluginOptions {
  scoutService?: ScoutService;
  keepAliveIntervalMs?: number;
}

interface ChatBody extends ScoutChatRequest {
  apiKey?: string;
  preferredEngine?: string;
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

    if (tripContext.waypoints.length > 100) {
      return reply.status(400).send({
        error: 'Request body "tripContext.waypoints" must not exceed 100 waypoints',
      });
    }

    try {
      scoutService.validateProvider(preferredEngine);
      await scoutService.resolveModelId(modelId, preferredEngine);
    } catch (err: unknown) {
      if (
        err instanceof InvalidModelError ||
        err instanceof UnknownAiProviderError ||
        (err as { statusCode?: number })?.statusCode === 400
      ) {
        return reply.status(400).send({ error: (err as Error).message });
      }
      throw err;
    }

    const abortController = new AbortController();
    const socket = request.raw.socket;
    const onChatClose = () => {
      abortController.abort();
    };
    reply.raw.on('close', onChatClose);
    socket?.on('close', onChatClose);

    try {
      const response = await scoutService.chat(
        { scope, messages, tripContext, sessionId, modelId },
        { apiKey, preferredEngine, modelId, abortSignal: abortController.signal }
      );
      return reply.status(200).send(response);
    } catch (err: unknown) {
      if (abortController.signal.aborted) {
        return;
      }
      if (err instanceof InvalidModelError || (err as { statusCode?: number })?.statusCode === 400) {
        return reply.status(400).send({ error: (err as Error).message });
      }
      if (err instanceof MalformedAiResponseError) {
        fastify.log.error({ err }, `AI provider returned an unusable Route Scout response: ${err.message}`);
        return reply.status(502).send({ error: err.message });
      }
      const message = err instanceof Error ? err.message : 'Route Scout error';
      fastify.log.error({ err }, `Route Scout chat failed: ${message}`);
      return reply.status(500).send({ error: message });
    } finally {
      reply.raw.removeListener('close', onChatClose);
      socket?.removeListener('close', onChatClose);
    }
  });

  // POST /api/ai/scout/chat/stream (SSE streaming)
  fastify.post<{ Body: ChatBody }>('/api/ai/scout/chat/stream', async (request, reply) => {
    const { scope, messages, tripContext, sessionId, apiKey, preferredEngine, modelId } = request.body || {};

    if (
      !scope ||
      !scope.type ||
      !Array.isArray(messages) ||
      messages.length === 0 ||
      !tripContext ||
      !Array.isArray(tripContext.waypoints)
    ) {
      return reply.status(400).send({
        error: 'Invalid request payload for Scout chat stream',
      });
    }

    if (tripContext.waypoints.length > 100) {
      return reply.status(400).send({
        error: 'Request body "tripContext.waypoints" must not exceed 100 waypoints',
      });
    }

    const abortController = new AbortController();
    let preStreamClosed = Boolean(
      reply.raw.destroyed ||
      request.raw.socket?.destroyed ||
      !request.raw.socket
    );

    const onPreStreamClose = () => {
      preStreamClosed = true;
      abortController.abort();
    };

    reply.raw.on('close', onPreStreamClose);
    const socket = request.raw.socket;
    socket?.on('close', onPreStreamClose);

    let resolvedModelId: string | undefined;
    try {
      if (preStreamClosed || abortController.signal.aborted) {
        return;
      }

      scoutService.validateProvider(preferredEngine);
      resolvedModelId = await scoutService.resolveModelId(modelId, preferredEngine);

      if (
        preStreamClosed ||
        abortController.signal.aborted ||
        reply.raw.destroyed ||
        socket?.destroyed
      ) {
        return;
      }
    } catch (err: unknown) {
      if (
        preStreamClosed ||
        abortController.signal.aborted ||
        reply.raw.destroyed ||
        socket?.destroyed
      ) {
        return;
      }
      if (
        err instanceof InvalidModelError ||
        err instanceof UnknownAiProviderError ||
        (err as { statusCode?: number })?.statusCode === 400
      ) {
        return reply.status(400).send({ error: (err as Error).message });
      }
      throw err;
    } finally {
      reply.raw.removeListener('close', onPreStreamClose);
      socket?.removeListener('close', onPreStreamClose);
    }

    if (
      preStreamClosed ||
      abortController.signal.aborted ||
      reply.raw.destroyed ||
      socket?.destroyed
    ) {
      return;
    }

    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders?.();
    reply.raw.write(': ping\n\n');

    let streamClosed = false;

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
        { scope, messages, tripContext, sessionId, modelId: resolvedModelId },
        (streamEvent) => {
          sendEvent(streamEvent.event, streamEvent.data);
        },
        { apiKey, preferredEngine, modelId: resolvedModelId, abortSignal: abortController.signal }
      );
    } catch (err: unknown) {
      if (abortController.signal.aborted || streamClosed) {
        return;
      }
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
