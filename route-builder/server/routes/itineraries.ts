import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import {
  ItineraryStorageService,
  defaultItineraryStorageService,
} from '../services/itineraryStorageService.js';

export interface ItineraryPluginOptions {
  storageService?: ItineraryStorageService;
}

interface SaveItineraryBody {
  content: unknown;
}

export const itineraryRoutes: FastifyPluginAsync<ItineraryPluginOptions> = async (
  fastify: FastifyInstance,
  options: ItineraryPluginOptions
) => {
  const service = options.storageService || defaultItineraryStorageService;

  // GET /api/itineraries - List all itineraries available in workspace
  fastify.get('/api/itineraries', async (_request, reply) => {
    try {
      const items = await service.listItineraries();
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
      try {
        const itinerary = await service.getItinerary(filename);
        if (!itinerary) {
          return reply.status(404).send({
            error: `Itinerary "${filename}" not found`,
          });
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

      try {
        const result = await service.saveItinerary(filename, content);
        return reply.status(200).send(result);
      } catch (err: unknown) {
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
      try {
        const result = await service.deleteItinerary(filename);
        return reply.status(200).send(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Failed to delete itinerary';
        const isNotFound = msg.toLowerCase().includes('not found');
        const isProtected = msg.toLowerCase().includes('protected');
        const status = isNotFound ? 404 : isProtected ? 403 : 500;
        return reply.status(status).send({ error: msg });
      }
    }
  );
};
