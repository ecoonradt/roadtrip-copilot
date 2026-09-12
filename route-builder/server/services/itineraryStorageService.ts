import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface ItineraryDaySummary {
  dayNumber: number;
  date: string;
  title?: string;
  checkpointCount: number;
  origin?: string;
  destination?: string;
}

export interface ItineraryMetadataSummary {
  fileName: string;
  tripName: string;
  isMultiDay: boolean;
  dayCount: number;
  days: ItineraryDaySummary[];
  totalCheckpoints: number;
  dates?: { start: string; end: string };
  lastModified?: string;
}

export interface ItineraryStorageOptions {
  storageDirectories?: string[];
  primaryWriteDirectory?: string;
}

export class ItineraryStorageService {
  private storageDirectories: string[];
  private primaryWriteDirectory: string;

  constructor(options: ItineraryStorageOptions = {}) {
    const defaultRoot = path.resolve(process.cwd(), '..');
    const defaultAssets = path.resolve(defaultRoot, 'app/src/main/assets');

    this.storageDirectories = options.storageDirectories || [defaultRoot, defaultAssets];
    this.primaryWriteDirectory = options.primaryWriteDirectory || defaultRoot;
  }

  /**
   * Scans configured directories for valid road trip itinerary JSON files.
   */
  async listItineraries(): Promise<ItineraryMetadataSummary[]> {
    const seenFiles = new Set<string>();
    const results: ItineraryMetadataSummary[] = [];

    // Ignored filenames that are clearly not road trip itineraries
    const IGNORED_FILES = new Set([
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      'tsconfig.server.json',
      'tsconfig.node.json',
    ]);

    for (const dir of this.storageDirectories) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.json') || IGNORED_FILES.has(entry.name)) {
            continue;
          }

          if (seenFiles.has(entry.name)) {
            continue;
          }

          const filePath = path.join(dir, entry.name);
          try {
            const rawContent = await fs.readFile(filePath, 'utf-8');
            const data = JSON.parse(rawContent) as Record<string, unknown>;

            // Validate that this looks like an itinerary (has trip_name, days, or checkpoints)
            if (!data || typeof data !== 'object') continue;
            const hasTripName = typeof data.trip_name === 'string';
            const hasDays = Array.isArray(data.days);
            const hasCheckpoints = Array.isArray(data.checkpoints);

            if (!hasTripName && !hasDays && !hasCheckpoints) {
              continue;
            }

            const stat = await fs.stat(filePath);
            const summary = this.extractMetadataSummary(entry.name, data, stat.mtime.toISOString());
            results.push(summary);
            seenFiles.add(entry.name);
          } catch {
            // Ignore non-itinerary or invalid JSON files
          }
        }
      } catch {
        // Directory may not exist (e.g. assets in non-Android environments), ignore
      }
    }

    // Sort: multi-day first, then alphabetical by name
    return results.sort((a, b) => {
      if (a.isMultiDay !== b.isMultiDay) {
        return a.isMultiDay ? -1 : 1;
      }
      return a.tripName.localeCompare(b.tripName);
    });
  }

  /**
   * Reads and parses a specific itinerary JSON file by filename.
   */
  async getItinerary(fileName: string): Promise<Record<string, unknown> | null> {
    const safeName = path.basename(fileName);

    for (const dir of this.storageDirectories) {
      const filePath = path.join(dir, safeName);
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Continue searching other directories
      }
    }

    return null;
  }

  /**
   * Saves or updates an itinerary JSON file to the primary storage directory.
   */
  async saveItinerary(
    fileName: string,
    content: unknown
  ): Promise<{ success: boolean; fileName: string; filePath: string }> {
    let safeName = path.basename(fileName);
    if (!safeName.endsWith('.json')) {
      safeName = `${safeName}.json`;
    }

    const targetPath = path.join(this.primaryWriteDirectory, safeName);
    const jsonString = JSON.stringify(content, null, 2);

    await fs.writeFile(targetPath, jsonString, 'utf-8');

    return {
      success: true,
      fileName: safeName,
      filePath: targetPath,
    };
  }

  /**
   * Parses raw itinerary data into a clean metadata summary.
   */
  private extractMetadataSummary(
    fileName: string,
    data: Record<string, unknown>,
    lastModified?: string
  ): ItineraryMetadataSummary {
    const tripName =
      typeof data.trip_name === 'string'
        ? data.trip_name
        : typeof data.title === 'string'
        ? data.title
        : fileName.replace(/\.json$/, '');

    const daysRaw = Array.isArray(data.days) ? (data.days as Record<string, unknown>[]) : [];
    const isMultiDay = daysRaw.length > 0;

    let dayCount = 0;
    let totalCheckpoints = 0;
    const days: ItineraryDaySummary[] = [];

    if (isMultiDay) {
      dayCount = daysRaw.length;
      for (const d of daysRaw) {
        const checkpoints = Array.isArray(d.checkpoints) ? d.checkpoints : [];
        totalCheckpoints += checkpoints.length;

        days.push({
          dayNumber: typeof d.day === 'number' ? d.day : days.length + 1,
          date: typeof d.date === 'string' ? d.date : '',
          title: typeof d.title === 'string' ? d.title : undefined,
          checkpointCount: checkpoints.length,
          origin: typeof d.origin === 'string' ? d.origin : undefined,
          destination: typeof d.destination === 'string' ? d.destination : undefined,
        });
      }
    } else {
      dayCount = 1;
      const checkpoints = Array.isArray(data.checkpoints) ? data.checkpoints : [];
      totalCheckpoints = checkpoints.length;

      const originName =
        typeof data.origin === 'string'
          ? data.origin
          : data.origin && typeof (data.origin as Record<string, unknown>).address === 'string'
          ? (data.origin as Record<string, unknown>).address as string
          : undefined;

      const destinationName =
        typeof data.destination === 'string'
          ? data.destination
          : data.destination && typeof (data.destination as Record<string, unknown>).address === 'string'
          ? (data.destination as Record<string, unknown>).address as string
          : undefined;

      days.push({
        dayNumber: 1,
        date: typeof data.date === 'string' ? data.date : '',
        title: tripName,
        checkpointCount: totalCheckpoints,
        origin: originName,
        destination: destinationName,
      });
    }

    let dates: { start: string; end: string } | undefined;
    if (data.dates && typeof data.dates === 'object') {
      const dObj = data.dates as Record<string, unknown>;
      if (typeof dObj.start === 'string' && typeof dObj.end === 'string') {
        dates = { start: dObj.start, end: dObj.end };
      }
    }

    return {
      fileName,
      tripName,
      isMultiDay,
      dayCount,
      days,
      totalCheckpoints,
      dates,
      lastModified,
    };
  }
}

export const defaultItineraryStorageService = new ItineraryStorageService();
