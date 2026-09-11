import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { DeviceService, defaultDeviceService } from '../services/deviceService.js';

export interface DevicePluginOptions {
  deviceService?: DeviceService;
}

interface PushBody {
  itinerary: unknown;
  fileName?: string;
}

interface StageBody {
  itinerary: unknown;
  fileName?: string;
}

export const deviceRoutes: FastifyPluginAsync<DevicePluginOptions> = async (
  fastify: FastifyInstance,
  options: DevicePluginOptions
) => {
  const deviceService = options.deviceService || defaultDeviceService;

  // GET /api/device/status
  fastify.get('/api/device/status', async (_request, reply) => {
    try {
      const status = await deviceService.getConnectedDevices();
      return reply.status(200).send(status);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to query device status';
      return reply.status(500).send({ connected: false, devices: [], error: msg });
    }
  });

  // POST /api/device/push
  fastify.post<{ Body: PushBody }>('/api/device/push', async (request, reply) => {
    const { itinerary, fileName } = request.body || {};

    if (!itinerary) {
      return reply.status(400).send({
        success: false,
        error: 'Missing required "itinerary" in request body',
      });
    }

    try {
      const result = await deviceService.pushItinerary(itinerary, fileName);
      if (!result.success) {
        return reply.status(503).send(result);
      }
      return reply.status(200).send(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Device push error';
      return reply.status(500).send({ success: false, error: msg });
    }
  });

  // GET /api/device/network-info
  fastify.get('/api/device/network-info', async (_request, reply) => {
    try {
      const info = deviceService.getNetworkInfo();
      return reply.status(200).send(info);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Network info discovery error';
      return reply.status(500).send({ error: msg });
    }
  });

  // POST /api/device/stage
  fastify.post<{ Body: StageBody }>('/api/device/stage', async (request, reply) => {
    const { itinerary, fileName } = request.body || {};

    if (!itinerary) {
      return reply.status(400).send({
        error: 'Missing required "itinerary" in request body',
      });
    }

    try {
      const result = deviceService.stageItinerary(itinerary, fileName);
      return reply.status(200).send(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to stage itinerary';
      return reply.status(500).send({ error: msg });
    }
  });

  // GET /api/device/download/:filename
  fastify.get<{ Params: { filename: string } }>(
    '/api/device/download/:filename',
    async (request, reply) => {
      const { filename } = request.params;
      const content = deviceService.getStagedItinerary(filename);

      if (!content) {
        return reply.status(404).send({
          error: `Itinerary file "${filename}" not found or expired. Please re-stage from the Route Builder.`,
        });
      }

      reply.header('Content-Type', 'application/json; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(content);
    }
  );
};
