import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  PricingUnavailableError,
  validateBedrockPricingCatalog,
  type BedrockPricingCatalog,
} from './bedrockPricing.js';
import { KeyedMutex } from './itineraryStorageService.js';

export const PRICING_CACHE_S3_KEY = 'pricing/bedrock-us-east-2.json';
export const PRICING_CACHE_MEMORY_TTL_MS = 5 * 60 * 1000;
export const PRICING_CATALOG_STALE_MS = 7 * 24 * 60 * 60 * 1000;

export function getDefaultLocalPricingFilePath(): string {
  const cwd = process.cwd();
  const repoRoot =
    path.basename(cwd) === 'route-builder' || path.basename(cwd) === 'infra'
      ? path.resolve(cwd, '..')
      : cwd;
  return path.resolve(
    repoRoot,
    'itineraries/.spend/pricing/bedrock-us-east-2.json',
  );
}

export interface BedrockPricingCacheResult {
  catalog: BedrockPricingCatalog;
  isStale: boolean;
}

export interface BedrockPricingProvider {
  getCatalog(): Promise<BedrockPricingCacheResult>;
}

export interface BedrockPricingCacheLogger {
  warn(message: string): void;
}

export interface BedrockPricingCacheOptions {
  s3Bucket?: string;
  s3Client?: S3Client;
  region?: string;
  localFilePath?: string;
  memoryTtlMs?: number;
  staleThresholdMs?: number;
  now?: () => number;
  logger?: BedrockPricingCacheLogger;
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
    e.code === 'ENOENT' ||
    e.$metadata?.httpStatusCode === 404
  );
}

function assertNonEmptyValidatedCatalog(raw: unknown): BedrockPricingCatalog {
  let catalog: BedrockPricingCatalog;
  try {
    catalog = validateBedrockPricingCatalog(raw);
  } catch (err: unknown) {
    throw new PricingUnavailableError(
      `Invalid Bedrock pricing catalog: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (Object.keys(catalog.models).length === 0) {
    throw new PricingUnavailableError(
      'Invalid Bedrock pricing catalog: catalog contains zero priced models',
    );
  }
  return catalog;
}

export class BedrockPricingCache implements BedrockPricingProvider {
  private readonly s3Bucket: string | null;
  private readonly s3Client: S3Client | null;
  private readonly localFilePath: string;
  private readonly memoryTtlMs: number;
  private readonly staleThresholdMs: number;
  private readonly now: () => number;
  private readonly logger: BedrockPricingCacheLogger;

  private cachedCatalog: BedrockPricingCatalog | null = null;
  private cachedAt = 0;
  private retainedAfterFailure = false;
  private inFlightRead: Promise<BedrockPricingCacheResult> | null = null;

  constructor(options: BedrockPricingCacheOptions = {}) {
    const configuredBucket = (options.s3Bucket ?? process.env.S3_STORAGE_BUCKET ?? '').trim();
    this.s3Bucket = configuredBucket.length > 0 ? configuredBucket : null;
    if (this.s3Bucket !== null) {
      const region =
        options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
      this.s3Client =
        options.s3Client ?? new S3Client(region ? { region } : {});
    } else {
      this.s3Client = options.s3Client ?? null;
    }

    this.localFilePath = options.localFilePath ?? getDefaultLocalPricingFilePath();
    this.memoryTtlMs = options.memoryTtlMs ?? PRICING_CACHE_MEMORY_TTL_MS;
    this.staleThresholdMs = options.staleThresholdMs ?? PRICING_CATALOG_STALE_MS;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
  }

  public getStorageLocation(): string {
    if (this.s3Bucket !== null) {
      return `s3://${this.s3Bucket}/${PRICING_CACHE_S3_KEY}`;
    }
    return this.localFilePath;
  }

  public isCatalogStale(catalog: BedrockPricingCatalog, nowMs = this.now()): boolean {
    const refreshedMs = Date.parse(catalog.refreshedAt);
    if (Number.isNaN(refreshedMs)) {
      return true;
    }
    return nowMs - refreshedMs > this.staleThresholdMs;
  }

  public async getCatalog(): Promise<BedrockPricingCacheResult> {
    const nowMs = this.now();
    if (this.cachedCatalog !== null && nowMs - this.cachedAt < this.memoryTtlMs) {
      const isStale =
        this.retainedAfterFailure || this.isCatalogStale(this.cachedCatalog, nowMs);
      return {
        catalog: this.cachedCatalog,
        isStale,
      };
    }

    if (this.inFlightRead !== null) {
      return this.inFlightRead;
    }

    this.inFlightRead = (async () => {
      try {
        const rawJson = await this.readRawStorage();
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawJson);
        } catch (err: unknown) {
          throw new PricingUnavailableError(
            `Bedrock pricing catalog at ${this.getStorageLocation()} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const catalog = assertNonEmptyValidatedCatalog(parsed);
        const loadedAt = this.now();
        this.cachedCatalog = catalog;
        this.cachedAt = loadedAt;
        this.retainedAfterFailure = false;

        const isStale = this.isCatalogStale(catalog, loadedAt);
        if (isStale) {
          this.logger.warn(
            `Bedrock pricing catalog at ${this.getStorageLocation()} is stale (refreshedAt: ${catalog.refreshedAt}); continuing with cached rates.`,
          );
        }

        return {
          catalog,
          isStale,
        };
      } catch (err: unknown) {
        if (this.cachedCatalog !== null) {
          const fallbackAt = this.now();
          this.cachedAt = fallbackAt;
          this.retainedAfterFailure = true;
          const detail = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Failed to reload Bedrock pricing catalog from ${this.getStorageLocation()} (${detail}); retaining last valid cached catalog as stale.`,
          );
          return {
            catalog: this.cachedCatalog,
            isStale: true,
          };
        }
        if (err instanceof PricingUnavailableError) {
          throw err;
        }
        throw new PricingUnavailableError(
          `Bedrock pricing catalog is unavailable at ${this.getStorageLocation()}: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        this.inFlightRead = null;
      }
    })();

    return this.inFlightRead;
  }

  public async writeCatalog(
    catalog: BedrockPricingCatalog,
  ): Promise<{ storageLocation: string }> {
    const validated = assertNonEmptyValidatedCatalog(catalog);
    const jsonString = JSON.stringify(validated, null, 2);

    if (this.s3Bucket !== null) {
      await this.s3Client!.send(
        new PutObjectCommand({
          Bucket: this.s3Bucket,
          Key: PRICING_CACHE_S3_KEY,
          Body: jsonString,
          ContentType: 'application/json',
        }),
      );
      this.cachedCatalog = validated;
      this.cachedAt = this.now();
      this.retainedAfterFailure = false;
      return { storageLocation: this.getStorageLocation() };
    }

    await KeyedMutex.runExclusive(this.localFilePath, async () => {
      await fs.mkdir(path.dirname(this.localFilePath), { recursive: true });
      const tempPath = `${this.localFilePath}.tmp.${this.now()}.${Math.random().toString(36).slice(2)}`;
      try {
        await fs.writeFile(tempPath, jsonString, 'utf-8');
        await fs.rename(tempPath, this.localFilePath);
      } catch (err: unknown) {
        await fs.rm(tempPath, { force: true }).catch(() => {});
        throw err;
      }
    });

    this.cachedCatalog = validated;
    this.cachedAt = this.now();
    this.retainedAfterFailure = false;
    return { storageLocation: this.localFilePath };
  }

  private async readRawStorage(): Promise<string> {
    if (this.s3Bucket !== null) {
      try {
        const response = await this.s3Client!.send(
          new GetObjectCommand({
            Bucket: this.s3Bucket,
            Key: PRICING_CACHE_S3_KEY,
          }),
        );
        return await streamToString(response.Body);
      } catch (err: unknown) {
        if (isNotFoundError(err)) {
          throw new PricingUnavailableError(
            `Bedrock pricing catalog not found at s3://${this.s3Bucket}/${PRICING_CACHE_S3_KEY}. Invoke the RefreshBedrockPricingFunction Lambda to initialize it.`,
          );
        }
        throw new PricingUnavailableError(
          `Failed to read Bedrock pricing catalog from s3://${this.s3Bucket}/${PRICING_CACHE_S3_KEY}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    try {
      return await fs.readFile(this.localFilePath, 'utf-8');
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        throw new PricingUnavailableError(
          `Bedrock pricing catalog not found at ${this.localFilePath}. Run "npm run refresh:pricing" in route-builder/ to initialize the local pricing catalog.`,
        );
      }
      throw new PricingUnavailableError(
        `Failed to read Bedrock pricing catalog from ${this.localFilePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
