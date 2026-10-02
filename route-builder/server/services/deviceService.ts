import * as os from 'node:os';
import type {
  NetworkInfo,
  StageItineraryResult,
} from '../types/device.js';

export interface DeviceServiceOptions {
  networkInterfacesProvider?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  port?: number;
}

interface StagedFile {
  content: string;
  createdAt: number;
}

export class DeviceService {
  private networkInterfacesProvider: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  private port: number;
  private stagedFiles = new Map<string, StagedFile>();

  constructor(options: DeviceServiceOptions = {}) {
    this.networkInterfacesProvider = options.networkInterfacesProvider || (() => os.networkInterfaces());
    this.port = options.port || parseInt(process.env.PORT || '3001', 10);
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
