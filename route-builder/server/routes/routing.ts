import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { GeocodeService, defaultGeocodeService } from '../services/geocodeService.js';
import { RouteService, defaultRouteService } from '../services/routeService.js';

export interface RoutingPluginOptions {
  geocodeService?: GeocodeService;
  routeService?: RouteService;
}

interface GeocodeQuery {
  q?: string;
}

interface RouteQuery {
  coords?: string;
}

export const routingRoutes: FastifyPluginAsync<RoutingPluginOptions> = async (
  fastify: FastifyInstance,
  options: RoutingPluginOptions
) => {
  const geocodeService = options.geocodeService || defaultGeocodeService;
  const routeService = options.routeService || defaultRouteService;

  // GET /api/routing/geocode?q=...
  fastify.get<{ Querystring: GeocodeQuery }>(
    '/api/routing/geocode',
    async (request, reply) => {
      const { q } = request.query;

      if (!q || typeof q !== 'string' || !q.trim()) {
        return reply.status(400).send({
          error: 'Query parameter "q" is required and cannot be empty',
        });
      }

      try {
        const results = await geocodeService.geocode(q);
        return reply.status(200).send(results);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown geocoding error';
        fastify.log.error({ err }, `Geocoding failed for query "${q}": ${message}`);

        const statusCode = message.includes('rate limit') ? 429 : 502;
        return reply.status(statusCode).send({ error: message });
      }
    }
  );

  // GET /api/routing/route?coords=lon1,lat1;lon2,lat2
  fastify.get<{ Querystring: RouteQuery }>(
    '/api/routing/route',
    async (request, reply) => {
      const { coords } = request.query;

      if (!coords || typeof coords !== 'string' || !coords.trim()) {
        return reply.status(400).send({
          error: 'Query parameter "coords" is required (format: "lon1,lat1;lon2,lat2")',
        });
      }

      try {
        const route = await routeService.getRoute(coords);
        return reply.status(200).send(route);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown routing error';
        fastify.log.error({ err }, `Routing failed for coordinates "${coords}": ${message}`);

        // Input validation errors return 400, external service errors return 502
        const isValidationError =
          message.includes('requires at least two coordinate waypoints') ||
          message.includes('Invalid waypoint format') ||
          message.includes('must be valid numbers') ||
          message.includes('out of bounds');

        const statusCode = isValidationError ? 400 : 502;
        return reply.status(statusCode).send({ error: message });
      }
    }
  );
};
