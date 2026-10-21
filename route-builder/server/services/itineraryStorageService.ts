import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import crypto from 'node:crypto';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  type PutObjectCommandInput,
  type HeadObjectOutput,
} from '@aws-sdk/client-s3';

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
  isProtected?: boolean;
  etag?: string;
}

export interface ItineraryRecord extends Record<string, unknown> {
  _etag?: string;
  _lastModified?: string;
  _isProtected?: boolean;
}

export interface SaveItineraryOptions {
  userEmail?: string;
  ifMatch?: string;
  ifNoneMatch?: string;
}

export interface SaveItineraryResult {
  success: boolean;
  fileName: string;
  filePath?: string;
  etag?: string;
}

export interface DeleteItineraryOptions {
  userEmail?: string;
  ifMatch?: string;
}

export interface DeleteItineraryResult {
  success: boolean;
  fileName: string;
}

export class PreconditionFailedError extends Error {
  readonly statusCode: number = 412;
  constructor(message = 'Precondition Failed') {
    super(message);
    this.name = 'PreconditionFailedError';
  }
}

export interface IItineraryStorageService {
  listItineraries(userEmail?: string): Promise<ItineraryMetadataSummary[]>;
  getItinerary(fileName: string, userEmail?: string): Promise<ItineraryRecord | null>;
  saveItinerary(
    fileName: string,
    content: unknown,
    options?: SaveItineraryOptions
  ): Promise<SaveItineraryResult>;
  deleteItinerary(
    fileName: string,
    options?: DeleteItineraryOptions
  ): Promise<DeleteItineraryResult>;
}

export function normalizeEtag(etag?: string): string {
  if (!etag) return '';
  let cleaned = etag.trim();
  if (cleaned.startsWith('W/')) {
    cleaned = cleaned.slice(2).trim();
  }
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  return cleaned;
}

export function computeLocalEtag(content: string | Buffer): string {
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 32);
  return `"${hash}"`;
}

export function isItineraryData(data: unknown): data is Record<string, unknown> {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  const hasTripName = typeof d.trip_name === 'string';
  const hasTitle = typeof d.title === 'string';
  const hasDays = Array.isArray(d.days);
  const hasCheckpoints = Array.isArray(d.checkpoints);
  return hasTripName || hasTitle || hasDays || hasCheckpoints;
}

export function extractMetadataSummary(
  fileName: string,
  data: Record<string, unknown>,
  lastModified?: string,
  isProtected?: boolean,
  etag?: string
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
        ? ((data.origin as Record<string, unknown>).address as string)
        : undefined;

    const destinationName =
      typeof data.destination === 'string'
        ? data.destination
        : data.destination &&
          typeof (data.destination as Record<string, unknown>).address === 'string'
        ? ((data.destination as Record<string, unknown>).address as string)
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
    isProtected,
    etag,
  };
}

async function streamToString(stream: unknown): Promise<string> {
  if (!stream) return '';
  if (
    typeof (stream as { transformToString?: () => Promise<string> }).transformToString ===
    'function'
  ) {
    return (stream as { transformToString: () => Promise<string> }).transformToString();
  }
  if (typeof (stream as { text?: () => Promise<string> }).text === 'function') {
    return (stream as { text: () => Promise<string> }).text();
  }
  if (typeof (stream as NodeJS.ReadableStream)[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
  }
  if (typeof stream === 'string') return stream;
  return String(stream);
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    name?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    e.name === 'NoSuchKey' ||
    e.name === 'NotFound' ||
    e.code === 'NoSuchKey' ||
    e.code === 'NotFound' ||
    e.$metadata?.httpStatusCode === 404
  );
}

function isPreconditionFailedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    name?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
    message?: string;
  };
  return (
    e.name === 'PreconditionFailed' ||
    e.code === 'PreconditionFailed' ||
    e.$metadata?.httpStatusCode === 412 ||
    (typeof e.message === 'string' && e.message.toLowerCase().includes('precondition failed'))
  );
}

export interface LocalFileSystemStorageOptions {
  storageDirectories?: string[];
  primaryWriteDirectory?: string;
}

export class LocalFileSystemStorageService implements IItineraryStorageService {
  private storageDirectories: string[];
  private primaryWriteDirectory: string;

  constructor(options: LocalFileSystemStorageOptions = {}) {
    const defaultRoot = path.resolve(process.cwd(), '..');
    const defaultItineraries = path.resolve(defaultRoot, 'itineraries');
    const defaultAssets = path.resolve(defaultRoot, 'app/src/main/assets');

    this.storageDirectories = options.storageDirectories || [
      defaultItineraries,
      defaultAssets,
      defaultRoot,
    ];
    this.primaryWriteDirectory = options.primaryWriteDirectory || defaultItineraries;
  }

  async listItineraries(_userEmail?: string): Promise<ItineraryMetadataSummary[]> {
    const seenFiles = new Set<string>();
    const results: ItineraryMetadataSummary[] = [];

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

            if (!isItineraryData(data)) {
              continue;
            }

            const stat = await fs.stat(filePath);
            const isPrimary = path.resolve(dir) === path.resolve(this.primaryWriteDirectory);
            const isProtected = !isPrimary || entry.name === 'sample_itinerary.json';
            const etag = computeLocalEtag(rawContent);
            const summary = extractMetadataSummary(
              entry.name,
              data,
              stat.mtime.toISOString(),
              isProtected,
              etag
            );
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

    return results.sort((a, b) => {
      if (a.isMultiDay !== b.isMultiDay) {
        return a.isMultiDay ? -1 : 1;
      }
      return a.tripName.localeCompare(b.tripName);
    });
  }

  async getItinerary(fileName: string, _userEmail?: string): Promise<ItineraryRecord | null> {
    let safeName = path.basename(fileName);
    if (!safeName.endsWith('.json')) {
      safeName = `${safeName}.json`;
    }

    for (const dir of this.storageDirectories) {
      const filePath = path.join(dir, safeName);
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const data = JSON.parse(raw) as ItineraryRecord;
        const stat = await fs.stat(filePath);
        const isPrimary = path.resolve(dir) === path.resolve(this.primaryWriteDirectory);
        data._etag = computeLocalEtag(raw);
        data._lastModified = stat.mtime.toISOString();
        data._isProtected = !isPrimary || safeName === 'sample_itinerary.json';
        return data;
      } catch {
        // Continue searching other directories
      }
    }

    return null;
  }

  async saveItinerary(
    fileName: string,
    content: unknown,
    options?: SaveItineraryOptions
  ): Promise<SaveItineraryResult> {
    let safeName = path.basename(fileName);
    if (!safeName.endsWith('.json')) {
      safeName = `${safeName}.json`;
    }

    const targetPath = path.join(this.primaryWriteDirectory, safeName);

    let existingContent: string | null = null;
    let existingEtag: string | null = null;
    try {
      existingContent = await fs.readFile(targetPath, 'utf-8');
      existingEtag = computeLocalEtag(existingContent);
    } catch {
      // File does not exist yet
    }

    if (options?.ifNoneMatch) {
      if (options.ifNoneMatch === '*' && existingContent !== null) {
        throw new PreconditionFailedError(`Resource already exists (If-None-Match: *)`);
      }
      if (
        options.ifNoneMatch !== '*' &&
        existingEtag &&
        normalizeEtag(existingEtag) === normalizeEtag(options.ifNoneMatch)
      ) {
        throw new PreconditionFailedError(
          `Resource matches If-None-Match: ${options.ifNoneMatch}`
        );
      }
    }

    if (options?.ifMatch) {
      if (existingContent === null) {
        throw new PreconditionFailedError(
          `Resource does not exist for If-Match: ${options.ifMatch}`
        );
      }
      if (
        options.ifMatch !== '*' &&
        existingEtag &&
        normalizeEtag(existingEtag) !== normalizeEtag(options.ifMatch)
      ) {
        throw new PreconditionFailedError(
          `ETag mismatch for If-Match: existing ${existingEtag} does not match ${options.ifMatch}`
        );
      }
    }

    const jsonString = JSON.stringify(content, null, 2);
    await fs.writeFile(targetPath, jsonString, 'utf-8');
    const newEtag = computeLocalEtag(jsonString);

    return {
      success: true,
      fileName: safeName,
      filePath: targetPath,
      etag: newEtag,
    };
  }

  async deleteItinerary(
    fileName: string,
    options?: DeleteItineraryOptions
  ): Promise<DeleteItineraryResult> {
    let safeName = path.basename(fileName);
    if (!safeName.endsWith('.json')) {
      safeName = `${safeName}.json`;
    }

    if (safeName === 'sample_itinerary.json') {
      throw new Error(`Cannot delete protected itinerary: ${safeName}`);
    }

    const targetPath = path.join(this.primaryWriteDirectory, safeName);

    let existingContent: string;
    try {
      existingContent = await fs.readFile(targetPath, 'utf-8');
    } catch {
      throw new Error(`Itinerary "${safeName}" not found in writable storage`);
    }

    if (options?.ifMatch) {
      const existingEtag = computeLocalEtag(existingContent);
      if (
        options.ifMatch !== '*' &&
        normalizeEtag(existingEtag) !== normalizeEtag(options.ifMatch)
      ) {
        throw new PreconditionFailedError(
          `ETag mismatch for If-Match: existing ${existingEtag} does not match ${options.ifMatch}`
        );
      }
    }

    await fs.unlink(targetPath);

    return {
      success: true,
      fileName: safeName,
    };
  }
}

export interface S3ItineraryStorageOptions {
  bucketName?: string;
  s3Client?: S3Client;
  region?: string;
  fallbackDirectories?: string[];
}

export class S3ItineraryStorageService implements IItineraryStorageService {
  private bucketName: string;
  private client: S3Client;
  private fallbackDirectories: string[];

  constructor(options: S3ItineraryStorageOptions = {}) {
    this.bucketName = options.bucketName || process.env.S3_STORAGE_BUCKET || '';
    if (!this.bucketName) {
      throw new Error(
        'S3ItineraryStorageService requires bucketName option or S3_STORAGE_BUCKET environment variable'
      );
    }
    this.client =
      options.s3Client ||
      new S3Client({
        region: options.region || process.env.AWS_REGION || 'us-east-1',
      });

    const defaultRoot = path.resolve(process.cwd(), '..');
    const defaultItineraries = path.resolve(defaultRoot, 'itineraries');
    const defaultAssets = path.resolve(defaultRoot, 'app/src/main/assets');
    this.fallbackDirectories = options.fallbackDirectories || [
      defaultAssets,
      defaultItineraries,
      defaultRoot,
    ];
  }

  getUserPrefix(userEmail?: string): string {
    const safeEmail = (userEmail || 'local-dev@localhost')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9.@_-]/g, '_');
    return `users/${safeEmail}/itineraries/`;
  }

  async listItineraries(userEmail?: string): Promise<ItineraryMetadataSummary[]> {
    const prefix = this.getUserPrefix(userEmail);
    const results: ItineraryMetadataSummary[] = [];

    let contents: { Key?: string; ETag?: string; LastModified?: Date }[] = [];
    try {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: prefix,
        })
      );
      contents = res.Contents || [];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to list itineraries from S3 (${this.bucketName}): ${msg}`);
    }

    const jsonItems = contents.filter(
      (item) => typeof item.Key === 'string' && item.Key.endsWith('.json')
    );

    await Promise.all(
      jsonItems.map(async (item) => {
        if (!item.Key) return;
        try {
          const getRes = await this.client.send(
            new GetObjectCommand({
              Bucket: this.bucketName,
              Key: item.Key,
            })
          );
          const bodyStr = await streamToString(getRes.Body);
          const data = JSON.parse(bodyStr) as Record<string, unknown>;
          if (!isItineraryData(data)) return;

          const fileName = path.basename(item.Key);
          const lastModified = (item.LastModified || getRes.LastModified)?.toISOString();
          const etag = item.ETag || getRes.ETag;
          const summary = extractMetadataSummary(
            fileName,
            data,
            lastModified,
            false,
            etag
          );
          results.push(summary);
        } catch {
          // Ignore unreadable or corrupt S3 files
        }
      })
    );

    // If user list does not contain sample_itinerary.json, check fallback directories
    const hasSample = results.some((r) => r.fileName === 'sample_itinerary.json');
    if (!hasSample) {
      for (const dir of this.fallbackDirectories) {
        const samplePath = path.join(dir, 'sample_itinerary.json');
        try {
          const raw = await fs.readFile(samplePath, 'utf-8');
          const data = JSON.parse(raw) as Record<string, unknown>;
          if (isItineraryData(data)) {
            const stat = await fs.stat(samplePath);
            const summary = extractMetadataSummary(
              'sample_itinerary.json',
              data,
              stat.mtime.toISOString(),
              true,
              computeLocalEtag(raw)
            );
            results.push(summary);
            break;
          }
        } catch {
          // Continue searching fallback directories
        }
      }
    }

    return results.sort((a, b) => {
      if (a.isMultiDay !== b.isMultiDay) {
        return a.isMultiDay ? -1 : 1;
      }
      return a.tripName.localeCompare(b.tripName);
    });
  }

  async getItinerary(fileName: string, userEmail?: string): Promise<ItineraryRecord | null> {
    let safeName = path.basename(fileName);
    if (!safeName.endsWith('.json')) {
      safeName = `${safeName}.json`;
    }

    const prefix = this.getUserPrefix(userEmail);
    const key = `${prefix}${safeName}`;

    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        })
      );
      const bodyStr = await streamToString(res.Body);
      const data = JSON.parse(bodyStr) as ItineraryRecord;
      data._etag = res.ETag;
      data._lastModified = res.LastModified?.toISOString();
      data._isProtected = false;
      return data;
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        if (safeName === 'sample_itinerary.json') {
          for (const dir of this.fallbackDirectories) {
            const samplePath = path.join(dir, 'sample_itinerary.json');
            try {
              const raw = await fs.readFile(samplePath, 'utf-8');
              const data = JSON.parse(raw) as ItineraryRecord;
              const stat = await fs.stat(samplePath);
              data._etag = computeLocalEtag(raw);
              data._lastModified = stat.mtime.toISOString();
              data._isProtected = true;
              return data;
            } catch {
              // Try next fallback directory
            }
          }
        }
        return null;
      }
      throw err;
    }
  }

  async saveItinerary(
    fileName: string,
    content: unknown,
    options?: SaveItineraryOptions
  ): Promise<SaveItineraryResult> {
    let safeName = path.basename(fileName);
    if (!safeName.endsWith('.json')) {
      safeName = `${safeName}.json`;
    }

    const prefix = this.getUserPrefix(options?.userEmail);
    const key = `${prefix}${safeName}`;
    const jsonString = JSON.stringify(content, null, 2);

    const input: PutObjectCommandInput = {
      Bucket: this.bucketName,
      Key: key,
      Body: jsonString,
      ContentType: 'application/json',
    };

    if (options?.ifMatch) {
      input.IfMatch = options.ifMatch;
    }
    if (options?.ifNoneMatch) {
      input.IfNoneMatch = options.ifNoneMatch;
    }

    try {
      const response = await this.client.send(new PutObjectCommand(input));
      return {
        success: true,
        fileName: safeName,
        filePath: `s3://${this.bucketName}/${key}`,
        etag: response.ETag,
      };
    } catch (err: unknown) {
      if (isPreconditionFailedError(err)) {
        throw new PreconditionFailedError(
          `Precondition failed for "${safeName}": ETag or condition mismatch (If-Match / If-None-Match)`
        );
      }
      throw err;
    }
  }

  async deleteItinerary(
    fileName: string,
    options?: DeleteItineraryOptions
  ): Promise<DeleteItineraryResult> {
    let safeName = path.basename(fileName);
    if (!safeName.endsWith('.json')) {
      safeName = `${safeName}.json`;
    }

    if (safeName === 'sample_itinerary.json') {
      throw new Error(`Cannot delete protected itinerary: ${safeName}`);
    }

    const prefix = this.getUserPrefix(options?.userEmail);
    const key = `${prefix}${safeName}`;

    let headRes: HeadObjectOutput;
    try {
      headRes = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        })
      );
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        throw new Error(`Itinerary "${safeName}" not found in writable storage`);
      }
      throw err;
    }

    if (options?.ifMatch) {
      if (
        options.ifMatch !== '*' &&
        normalizeEtag(headRes.ETag) !== normalizeEtag(options.ifMatch)
      ) {
        throw new PreconditionFailedError(
          `ETag mismatch for delete: existing ${headRes.ETag} does not match ${options.ifMatch}`
        );
      }
    }

    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      })
    );

    return {
      success: true,
      fileName: safeName,
    };
  }
}

export interface ItineraryStorageOptions extends LocalFileSystemStorageOptions {
  s3Bucket?: string;
  s3Client?: S3Client;
  region?: string;
}

export class ItineraryStorageService implements IItineraryStorageService {
  private delegate: IItineraryStorageService;

  constructor(options: ItineraryStorageOptions = {}) {
    const s3Bucket = options.s3Bucket || process.env.S3_STORAGE_BUCKET;
    if (s3Bucket) {
      this.delegate = new S3ItineraryStorageService({
        bucketName: s3Bucket,
        s3Client: options.s3Client,
        region: options.region,
        fallbackDirectories: options.storageDirectories,
      });
    } else {
      this.delegate = new LocalFileSystemStorageService(options);
    }
  }

  getDelegate(): IItineraryStorageService {
    return this.delegate;
  }

  async listItineraries(userEmail?: string): Promise<ItineraryMetadataSummary[]> {
    return this.delegate.listItineraries(userEmail);
  }

  async getItinerary(fileName: string, userEmail?: string): Promise<ItineraryRecord | null> {
    return this.delegate.getItinerary(fileName, userEmail);
  }

  async saveItinerary(
    fileName: string,
    content: unknown,
    options?: SaveItineraryOptions
  ): Promise<SaveItineraryResult> {
    return this.delegate.saveItinerary(fileName, content, options);
  }

  async deleteItinerary(
    fileName: string,
    options?: DeleteItineraryOptions
  ): Promise<DeleteItineraryResult> {
    return this.delegate.deleteItinerary(fileName, options);
  }
}

export const defaultItineraryStorageService = new ItineraryStorageService();
