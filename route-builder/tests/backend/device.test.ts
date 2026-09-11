import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import { DeviceService } from '../../server/services/deviceService.js';
import { createApp } from '../../server/app.js';

describe('Backend Device & Handoff Service (deviceService.ts & routes/device.ts)', () => {
  describe('DeviceService Unit Tests', () => {
    it('detects connected devices when ADB reports device state', async () => {
      const mockAdb = vi.fn().mockResolvedValue({
        stdout: `List of devices attached
28251JEHN01234\tdevice
emulator-5554\tdevice
`,
        stderr: '',
      });

      const service = new DeviceService({ adbExecutor: mockAdb });
      const status = await service.getConnectedDevices();

      expect(status.connected).toBe(true);
      expect(status.devices).toEqual(['28251JEHN01234', 'emulator-5554']);
      expect(mockAdb).toHaveBeenCalledWith('adb devices', { timeout: 3000 });
    });

    it('ignores unauthorized or offline devices in ADB output', async () => {
      const mockAdb = vi.fn().mockResolvedValue({
        stdout: `List of devices attached
emulator-5554\toffline
unauth_device_123\tunauthorized
`,
        stderr: '',
      });

      const service = new DeviceService({ adbExecutor: mockAdb });
      const status = await service.getConnectedDevices();

      expect(status.connected).toBe(false);
      expect(status.devices).toEqual([]);
    });

    it('handles ADB command failure gracefully without throwing or hanging', async () => {
      const mockAdb = vi.fn().mockRejectedValue(new Error('spawn adb ENOENT'));

      const service = new DeviceService({ adbExecutor: mockAdb });
      const status = await service.getConnectedDevices();

      expect(status.connected).toBe(false);
      expect(status.devices).toEqual([]);
    });

    it('Invariant: ADB push returns clean error immediately if no device is connected without hanging', async () => {
      const mockAdb = vi.fn().mockResolvedValue({
        stdout: 'List of devices attached\n\n',
        stderr: '',
      });

      const service = new DeviceService({ adbExecutor: mockAdb });
      const result = await service.pushItinerary({ test: true }, 'test.json');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No connected Android device found via ADB');
      // Should not have attempted mkdir or push commands
      expect(mockAdb).toHaveBeenCalledTimes(1);
      expect(mockAdb).toHaveBeenCalledWith('adb devices', { timeout: 3000 });
    });

    it('executes push correctly when a device is connected', async () => {
      const commandsExecuted: string[] = [];
      const mockAdb = vi.fn().mockImplementation(async (cmd: string) => {
        commandsExecuted.push(cmd);
        if (cmd === 'adb devices') {
          return { stdout: 'List of devices attached\nPixel7Pro_001\tdevice\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      const service = new DeviceService({ adbExecutor: mockAdb });
      const result = await service.pushItinerary(
        { trip_name: 'Test Route' },
        'my_route.json'
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Successfully pushed my_route.json to device (Pixel7Pro_001)');
      expect(commandsExecuted.length).toBe(3);
      expect(commandsExecuted[0]).toBe('adb devices');
      expect(commandsExecuted[1]).toContain('shell mkdir -p /sdcard/Android/data/com.roadtrip.copilot/files/itineraries/');
      expect(commandsExecuted[2]).toContain('push');
      expect(commandsExecuted[2]).toContain('/sdcard/Android/data/com.roadtrip.copilot/files/itineraries/my_route.json');
    });

    it('handles ADB push failure gracefully and returns clean error', async () => {
      const mockAdb = vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === 'adb devices') {
          return { stdout: 'List of devices attached\nPixel7Pro_001\tdevice\n', stderr: '' };
        }
        if (cmd.includes('push')) {
          throw new Error('remote secure_mkdirs failed: Permission denied');
        }
        return { stdout: '', stderr: '' };
      });

      const service = new DeviceService({ adbExecutor: mockAdb });
      const result = await service.pushItinerary({ trip_name: 'Test' }, 'test.json');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
    });

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
    it('GET /api/device/status returns device list and connection status', async () => {
      const mockService = new DeviceService({
        adbExecutor: vi.fn().mockResolvedValue({
          stdout: 'List of devices attached\nPixel_Device_1\tdevice\n',
          stderr: '',
        }),
      });

      const app = createApp({ deviceService: mockService });
      const response = await app.inject({
        method: 'GET',
        url: '/api/device/status',
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.connected).toBe(true);
      expect(data.devices).toEqual(['Pixel_Device_1']);
    });

    it('POST /api/device/push rejects with 400 when itinerary body is missing', async () => {
      const app = createApp();
      const response = await app.inject({
        method: 'POST',
        url: '/api/device/push',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('Missing required "itinerary"');
    });

    it('POST /api/device/push returns 503 with clean error when no device is connected', async () => {
      const mockService = new DeviceService({
        adbExecutor: vi.fn().mockResolvedValue({
          stdout: 'List of devices attached\n\n',
          stderr: '',
        }),
      });

      const app = createApp({ deviceService: mockService });
      const response = await app.inject({
        method: 'POST',
        url: '/api/device/push',
        payload: {
          itinerary: { trip_name: 'Test Itinerary' },
          fileName: 'itinerary.json',
        },
      });

      expect(response.statusCode).toBe(503);
      const data = response.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain('No connected Android device found via ADB');
    });

    it('POST /api/device/push returns 200 when device push succeeds', async () => {
      const mockService = new DeviceService({
        adbExecutor: vi.fn().mockImplementation(async (cmd: string) => {
          if (cmd === 'adb devices') {
            return { stdout: 'List of devices attached\nPixel_1\tdevice\n', stderr: '' };
          }
          return { stdout: '', stderr: '' };
        }),
      });

      const app = createApp({ deviceService: mockService });
      const response = await app.inject({
        method: 'POST',
        url: '/api/device/push',
        payload: {
          itinerary: { trip_name: 'Test Itinerary' },
          fileName: 'route.json',
        },
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.success).toBe(true);
      expect(data.message).toContain('Successfully pushed route.json to device');
    });

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
  });
});
