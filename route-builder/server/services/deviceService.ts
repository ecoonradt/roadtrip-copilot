import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AdbDeviceStatus,
  AdbPushResult,
  NetworkInfo,
  StageItineraryResult,
} from '../types/device.js';

const execAsync = promisify(exec);

export type ExecFunction = (
  command: string,
  options?: { timeout?: number }
) => Promise<{ stdout: string; stderr: string }>;

export interface DeviceServiceOptions {
  adbExecutor?: ExecFunction;
  networkInterfacesProvider?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  port?: number;
}

interface StagedFile {
  content: string;
  createdAt: number;
}

export class DeviceService {
  private adbExecutor: ExecFunction;
  private networkInterfacesProvider: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  private port: number;
  private stagedFiles = new Map<string, StagedFile>();

  constructor(options: DeviceServiceOptions = {}) {
    this.adbExecutor = options.adbExecutor || ((cmd, opts) => execAsync(cmd, { timeout: opts?.timeout ?? 3000 }));
    this.networkInterfacesProvider = options.networkInterfacesProvider || (() => os.networkInterfaces());
    this.port = options.port || parseInt(process.env.PORT || '3001', 10);
  }

  /**
   * Checks connected devices via ADB CLI with a strict timeout.
   * Returns list of connected and authorized device identifiers.
   */
  async getConnectedDevices(): Promise<AdbDeviceStatus> {
    try {
      const { stdout } = await this.adbExecutor('adb devices', { timeout: 3000 });
      const lines = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      // Lines look like:
      // List of devices attached
      // 28251JEHN01234\tdevice
      // emulator-5554\toffline
      const devices: string[] = [];

      for (const line of lines) {
        if (line.startsWith('List of devices attached')) continue;
        if (line.startsWith('* daemon')) continue;

        const parts = line.split(/\s+/);
        if (parts.length >= 2) {
          const [deviceId, state] = parts;
          if (state === 'device') {
            devices.push(deviceId);
          }
        }
      }

      return {
        connected: devices.length > 0,
        devices,
      };
    } catch {
      // ADB command failed, timed out, or ADB is not in PATH
      return {
        connected: false,
        devices: [],
      };
    }
  }

  /**
   * Pushes the itinerary JSON directly into the phone's co-pilot directory via ADB.
   * Immediately fails with a clear message if no phone is connected.
   */
  async pushItinerary(itinerary: unknown, fileName?: string): Promise<AdbPushResult> {
    const status = await this.getConnectedDevices();
    if (!status.connected || status.devices.length === 0) {
      return {
        success: false,
        error:
          'No connected Android device found via ADB. Please connect your phone with USB debugging enabled.',
      };
    }

    const rawName = (fileName || 'itinerary.json').trim();
    const sanitizedBase = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const finalName = sanitizedBase.endsWith('.json') ? sanitizedBase : `${sanitizedBase}.json`;

    const jsonContent =
      typeof itinerary === 'string'
        ? itinerary
        : JSON.stringify(itinerary, null, 2);

    const tempFilePath = path.join(
      os.tmpdir(),
      `copilot_${Date.now()}_${finalName}`
    );

    const deviceId = status.devices[0];
    const deviceFlag = status.devices.length > 1 ? `-s ${deviceId} ` : '';
    const phoneTargetDir = '/sdcard/Android/data/com.roadtrip.copilot/files/itineraries/';
    const phoneTargetPath = `${phoneTargetDir}${finalName}`;

    try {
      await fs.writeFile(tempFilePath, jsonContent, 'utf-8');

      // 1. Ensure target directory exists on phone
      await this.adbExecutor(`adb ${deviceFlag}shell mkdir -p ${phoneTargetDir}`, {
        timeout: 5000,
      });

      // 2. Push file to phone
      await this.adbExecutor(`adb ${deviceFlag}push "${tempFilePath}" "${phoneTargetPath}"`, {
        timeout: 10000,
      });

      return {
        success: true,
        message: `Successfully pushed ${finalName} to device (${deviceId})`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'ADB push failed';
      return {
        success: false,
        error: `Failed to push itinerary via ADB: ${message}`,
      };
    } finally {
      // Always cleanup local temp file
      await fs.unlink(tempFilePath).catch(() => {});
    }
  }

  /**
   * Finds the best non-internal IPv4 address (e.g. Wi-Fi or Ethernet) for wireless transfer.
   */
  getLocalIpAddress(): string {
    const interfaces = this.networkInterfacesProvider();
    const candidates: Array<{ name: string; ip: string; isWifi: boolean }> = [];

    for (const [name, netList] of Object.entries(interfaces)) {
      if (!netList) continue;
      for (const net of netList) {
        // Skip internal (127.0.0.1) and non-IPv4
        if (net.internal) continue;
        const family = String(net.family);
        if (family !== 'IPv4') continue;

        const lowerName = name.toLowerCase();
        const isWifi =
          lowerName.includes('wlan') ||
          lowerName.includes('wl') ||
          lowerName.includes('wi-fi') ||
          lowerName.includes('wifi');

        candidates.push({ name, ip: net.address, isWifi });
      }
    }

    if (candidates.length === 0) {
      return '127.0.0.1';
    }

    // Prefer Wi-Fi interface if available
    const wifiCandidate = candidates.find((c) => c.isWifi);
    if (wifiCandidate) {
      return wifiCandidate.ip;
    }

    // Next prefer Ethernet ('eth', 'en')
    const ethCandidate = candidates.find((c) => {
      const l = c.name.toLowerCase();
      return l.startsWith('eth') || l.startsWith('en');
    });
    if (ethCandidate) {
      return ethCandidate.ip;
    }

    return candidates[0].ip;
  }

  /**
   * Returns network connectivity metadata for QR code construction.
   */
  getNetworkInfo(): NetworkInfo {
    return {
      ip: this.getLocalIpAddress(),
      port: this.port,
    };
  }

  /**
   * Stages an itinerary in memory for Wi-Fi QR download.
   */
  stageItinerary(itinerary: unknown, fileName?: string): StageItineraryResult {
    const rawName = (fileName || 'itinerary.json').trim();
    const sanitizedBase = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const finalName = sanitizedBase.endsWith('.json') ? sanitizedBase : `${sanitizedBase}.json`;

    const jsonContent =
      typeof itinerary === 'string'
        ? itinerary
        : JSON.stringify(itinerary, null, 2);

    this.stagedFiles.set(finalName, {
      content: jsonContent,
      createdAt: Date.now(),
    });

    // Housekeeping: remove files older than 24 hours
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    for (const [key, value] of this.stagedFiles.entries()) {
      if (value.createdAt < oneDayAgo) {
        this.stagedFiles.delete(key);
      }
    }

    const ip = this.getLocalIpAddress();
    const downloadUrl = `http://${ip}:${this.port}/api/device/download/${encodeURIComponent(finalName)}`;

    return {
      downloadUrl,
      fileName: finalName,
    };
  }

  /**
   * Retrieves staged itinerary file content by filename.
   */
  getStagedItinerary(fileName: string): string | null {
    const staged = this.stagedFiles.get(fileName);
    return staged ? staged.content : null;
  }
}

export const defaultDeviceService = new DeviceService();
