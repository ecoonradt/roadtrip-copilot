import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import {
  type IItineraryStorageService,
  ItineraryStorageService,
  PreconditionFailedError,
} from '../services/itineraryStorageService.js';

export interface ItineraryPluginOptions {
  storageService?: IItineraryStorageService;
}

interface SaveItineraryBody {
  content: unknown;
}

export const itineraryRoutes: FastifyPluginAsync<ItineraryPluginOptions> = async (
  fastify: FastifyInstance,
  options: ItineraryPluginOptions
) => {
  const service = options.storageService || new ItineraryStorageService();

  // GET /api/itineraries - List all itineraries available in workspace or user prefix
  fastify.get('/api/itineraries', async (request, reply) => {
    try {
      const userEmail = request.authUser?.email;
      const items = await service.listItineraries(userEmail);
      return reply.status(200).send({ itineraries: items });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to list itineraries';
      return reply.status(500).send({ error: msg });
    }
  });

  // GET /api/itineraries/:filename - Retrieve full JSON of an itinerary
  fastify.get<{ Params: { filename: string } }>(
    '/api/itineraries/:filename',
    async (request, reply) => {
      const { filename } = request.params;
      const userEmail = request.authUser?.email;
      try {
        const itinerary = await service.getItinerary(filename, userEmail);
        if (!itinerary) {
          return reply.status(404).send({
            error: `Itinerary "${filename}" not found`,
          });
        }
        if (itinerary._etag) {
          reply.header('ETag', itinerary._etag);
        }
        return reply.status(200).send(itinerary);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to load itinerary';
        return reply.status(500).send({ error: msg });
      }
    }
  );

  // POST /api/itineraries/:filename - Save or update an itinerary file
  fastify.post<{ Params: { filename: string }; Body: SaveItineraryBody }>(
    '/api/itineraries/:filename',
    async (request, reply) => {
      const { filename } = request.params;
      const { content } = request.body || {};

      if (!content) {
        return reply.status(400).send({
          error: 'Missing required "content" in request body',
        });
      }

      const userEmail = request.authUser?.email;
      const rawIfMatch = request.headers['if-match'];
      const ifMatch = Array.isArray(rawIfMatch) ? rawIfMatch[0] : rawIfMatch;
      const rawIfNoneMatch = request.headers['if-none-match'];
      const ifNoneMatch = Array.isArray(rawIfNoneMatch) ? rawIfNoneMatch[0] : rawIfNoneMatch;

      try {
        const result = await service.saveItinerary(filename, content, {
          userEmail,
          ifMatch,
          ifNoneMatch,
        });
        if (result.etag) {
          reply.header('ETag', result.etag);
        }
        return reply.status(200).send(result);
      } catch (err: unknown) {
        if (
          err instanceof PreconditionFailedError ||
          (err && typeof err === 'object' && (err as { statusCode?: number }).statusCode === 412)
        ) {
          const msg = err instanceof Error ? err.message : 'Precondition Failed';
          return reply.status(412).send({ error: msg });
        }
        const msg = err instanceof Error ? err.message : 'Failed to save itinerary';
        return reply.status(500).send({ error: msg });
      }
    }
  );

  // DELETE /api/itineraries/:filename - Delete an itinerary file from storage
  fastify.delete<{ Params: { filename: string } }>(
    '/api/itineraries/:filename',
    async (request, reply) => {
      const { filename } = request.params;
      const userEmail = request.authUser?.email;
      const rawIfMatch = request.headers['if-match'];
      const ifMatch = Array.isArray(rawIfMatch) ? rawIfMatch[0] : rawIfMatch;

      try {
        const result = await service.deleteItinerary(filename, {
          userEmail,
          ifMatch,
        });
        return reply.status(200).send(result);
      } catch (err: unknown) {
        if (
          err instanceof PreconditionFailedError ||
          (err && typeof err === 'object' && (err as { statusCode?: number }).statusCode === 412)
        ) {
          const msg = err instanceof Error ? err.message : 'Precondition Failed';
          return reply.status(412).send({ error: msg });
        }
        const msg = err instanceof Error ? err.message : 'Failed to delete itinerary';
        const isNotFound = msg.toLowerCase().includes('not found');
        const isProtected = msg.toLowerCase().includes('protected');
        const status = isNotFound ? 404 : isProtected ? 403 : 500;
        return reply.status(status).send({ error: msg });
      }
    }
  );
};
