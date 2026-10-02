import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import { DeviceService } from '../../server/services/deviceService.js';
import { createApp } from '../../server/app.js';

describe('Backend Device & Handoff Service (deviceService.ts & routes/device.ts)', () => {
  describe('DeviceService Unit Tests', () => {
    it('resolves local Wi-Fi IP address prioritizing wireless network interfaces', () => {
      const mockInterfaces = () =>
        ({
          lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as os.NetworkInterfaceInfo],
          eth0: [{ address: '192.168.1.50', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo],
          wlan0: [{ address: '192.168.1.105', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo],
        }) as NodeJS.Dict<os.NetworkInterfaceInfo[]>;

      const service = new DeviceService({ networkInterfacesProvider: mockInterfaces, port: 3001 });
      const ip = service.getLocalIpAddress();
      expect(ip).toBe('192.168.1.105');

      const info = service.getNetworkInfo();
      expect(info).toEqual({ ip: '192.168.1.105', port: 3001 });
    });

    it('falls back to Ethernet when Wi-Fi is not available', () => {
      const mockInterfaces = () =>
        ({
          lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as os.NetworkInterfaceInfo],
          enp3s0: [{ address: '10.0.0.42', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo],
        }) as NodeJS.Dict<os.NetworkInterfaceInfo[]>;

      const service = new DeviceService({ networkInterfacesProvider: mockInterfaces, port: 3001 });
      expect(service.getLocalIpAddress()).toBe('10.0.0.42');
    });

    it('falls back to 127.0.0.1 when only loopback interface exists', () => {
      const mockInterfaces = () =>
        ({
          lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as os.NetworkInterfaceInfo],
        }) as NodeJS.Dict<os.NetworkInterfaceInfo[]>;

      const service = new DeviceService({ networkInterfacesProvider: mockInterfaces, port: 3001 });
      expect(service.getLocalIpAddress()).toBe('127.0.0.1');
    });

    it('stages and retrieves itinerary for Wi-Fi download', () => {
      const service = new DeviceService({ port: 3001 });
      const staged = service.stageItinerary({ trip_name: 'Staged Trip' }, 'staged_trip.json');

      expect(staged.fileName).toBe('staged_trip.json');
      expect(staged.downloadUrl).toContain('/api/device/download/staged_trip.json');

      const retrieved = service.getStagedItinerary('staged_trip.json');
      expect(retrieved).not.toBeNull();
      const parsed = JSON.parse(retrieved!);
      expect(parsed.trip_name).toBe('Staged Trip');

      expect(service.getStagedItinerary('unknown.json')).toBeNull();
    });
  });

  describe('Device & Handoff Fastify Route Endpoints', () => {
    it('GET /api/device/network-info returns IP address and port', async () => {
      const mockService = new DeviceService({
        networkInterfacesProvider: () => ({
          wlan0: [{ address: '192.168.1.120', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo],
        }),
        port: 3001,
      });

      const app = createApp({ deviceService: mockService });
      const response = await app.inject({
        method: 'GET',
        url: '/api/device/network-info',
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.ip).toBe('192.168.1.120');
      expect(data.port).toBe(3001);
    });

    it('POST /api/device/stage and GET /api/device/download/:filename round-trip', async () => {
      const mockService = new DeviceService({
        networkInterfacesProvider: () => ({
          wlan0: [{ address: '192.168.1.120', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo],
        }),
        port: 3001,
      });

      const app = createApp({ deviceService: mockService });

      // 1. Stage the itinerary
      const stageResponse = await app.inject({
        method: 'POST',
        url: '/api/device/stage',
        payload: {
          itinerary: { trip_name: 'Roundtrip Test Trip' },
          fileName: 'my_trip.json',
        },
      });

      expect(stageResponse.statusCode).toBe(200);
      const stageData = stageResponse.json();
      expect(stageData.fileName).toBe('my_trip.json');
      expect(stageData.downloadUrl).toBe('http://192.168.1.120:3001/api/device/download/my_trip.json');

      // 2. Download the staged file via HTTP
      const downloadResponse = await app.inject({
        method: 'GET',
        url: '/api/device/download/my_trip.json',
      });

      expect(downloadResponse.statusCode).toBe(200);
      expect(downloadResponse.headers['content-type']).toContain('application/json');
      expect(downloadResponse.headers['content-disposition']).toContain('attachment; filename="my_trip.json"');

      const downloadedContent = JSON.parse(downloadResponse.payload);
      expect(downloadedContent.trip_name).toBe('Roundtrip Test Trip');

      // 3. Requesting a non-existent file returns 404
      const notFoundResponse = await app.inject({
        method: 'GET',
        url: '/api/device/download/does_not_exist.json',
      });
      expect(notFoundResponse.statusCode).toBe(404);
      expect(notFoundResponse.json().error).toContain('not found or expired');
    });

    it('POST /api/device/stage rejects with 400 when itinerary is missing', async () => {
      const app = createApp();
      const response = await app.inject({
        method: 'POST',
        url: '/api/device/stage',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('Missing required "itinerary"');
    });
  });
});
