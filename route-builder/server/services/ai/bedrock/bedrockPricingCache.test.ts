import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  PricingUnavailableError,
  type BedrockPricingCatalog,
} from './bedrockPricing.js';
import {
  BedrockPricingCache,
  PRICING_CACHE_MEMORY_TTL_MS,
  PRICING_CACHE_S3_KEY,
  PRICING_CATALOG_STALE_MS,
} from './bedrockPricingCache.js';
import {
  TEST_PRICING_REFRESHED_MS,
  makeTestPricingCatalog,
} from '../../../test-helpers/bedrockFixtures.js';

describe('BedrockPricingCache (S3 & local persistence, memory TTL, staleness & reload retention)', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bedrock-pricing-cache-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('writes and reads a local pricing catalog with 5-minute in-memory TTL and coalesced concurrent reads', async () => {
    const localFilePath = path.join(tempDir, 'pricing', 'bedrock-us-east-2.json');
    let currentNow = TEST_PRICING_REFRESHED_MS + 60_000;
    const warnSpy = vi.fn();

    const writerCache = new BedrockPricingCache({
      s3Bucket: '',
      localFilePath,
      now: () => currentNow,
      logger: { warn: warnSpy },
    });

    const catalog = makeTestPricingCatalog();
    const writeRes = await writerCache.writeCatalog(catalog);
    expect(writeRes.storageLocation).toBe(localFilePath);

    const readerCache = new BedrockPricingCache({
      s3Bucket: '',
      localFilePath,
      now: () => currentNow,
      logger: { warn: warnSpy },
    });

    const [r1, r2] = await Promise.all([readerCache.getCatalog(), readerCache.getCatalog()]);
    expect(r1.isStale).toBe(false);
    expect(r2.isStale).toBe(false);
    expect(r1.catalog).toEqual(catalog);

    // Delete the file on disk and advance within 5-minute TTL -> served from memory without touching disk
    await fs.rm(localFilePath, { force: true });
    currentNow += PRICING_CACHE_MEMORY_TTL_MS - 1_000;
    const r3 = await readerCache.getCatalog();
    expect(r3.isStale).toBe(false);
    expect(r3.catalog).toEqual(catalog);
    expect(warnSpy).not.toHaveBeenCalled();

    // Verify S3 concurrent read coalescing invokes S3Client.send only once
    const s3Send = vi.fn(async () => ({
      Body: {
        transformToString: async () => JSON.stringify(catalog),
      },
    }));
    const coalescedS3Cache = new BedrockPricingCache({
      s3Bucket: 'coalesce-bucket',
      s3Client: { send: s3Send } as unknown as S3Client,
      now: () => currentNow,
    });
    await Promise.all([coalescedS3Cache.getCatalog(), coalescedS3Cache.getCatalog()]);
    expect(s3Send).toHaveBeenCalledTimes(1);
  });

  it('marks catalog as stale and logs a warning when refreshedAt is older than 7 days', async () => {
    const localFilePath = path.join(tempDir, 'bedrock-us-east-2.json');
    const staleNow = TEST_PRICING_REFRESHED_MS + PRICING_CATALOG_STALE_MS + 1;
    const warnSpy = vi.fn();

    const cache = new BedrockPricingCache({
      s3Bucket: '',
      localFilePath,
      now: () => staleNow,
      logger: { warn: warnSpy },
    });

    await fs.writeFile(localFilePath, JSON.stringify(makeTestPricingCatalog()), 'utf-8');
    const res = await cache.getCatalog();
    expect(res.isStale).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('is stale');
  });

  it('retains the last valid in-memory catalog as stale when a subsequent reload from S3 or local disk fails', async () => {
    let currentNow = TEST_PRICING_REFRESHED_MS + 1_000;
    let shouldFailS3 = false;
    const warnSpy = vi.fn();
    const catalog = makeTestPricingCatalog();

    const mockS3 = {
      send: vi.fn(async () => {
        if (shouldFailS3) {
          throw new Error('S3 network timeout');
        }
        return {
          Body: {
            transformToString: async () => JSON.stringify(catalog),
          },
        };
      }),
    } as unknown as S3Client;

    const cache = new BedrockPricingCache({
      s3Bucket: 'roadtrip-app-data',
      s3Client: mockS3,
      now: () => currentNow,
      logger: { warn: warnSpy },
    });

    const initial = await cache.getCatalog();
    expect(initial.isStale).toBe(false);
    expect(initial.catalog).toEqual(catalog);

    // Expire the 5-minute memory TTL and make S3 fail on reload
    currentNow += PRICING_CACHE_MEMORY_TTL_MS + 1_000;
    shouldFailS3 = true;

    const fallback = await cache.getCatalog();
    expect(fallback.isStale).toBe(true);
    expect(fallback.catalog).toEqual(catalog);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('retaining last valid cached catalog as stale');
  });

  it('writes and reads from S3 when s3Bucket is configured, and fails with 503 PricingUnavailableError when missing or corrupt', async () => {
    const storedObjects = new Map<string, string>();
    const mockS3 = {
      send: vi.fn(
        async (cmd: {
          constructor: { name: string };
          input: { Bucket: string; Key: string; Body?: string };
        }) => {
          if (cmd.constructor.name === 'PutObjectCommand') {
            storedObjects.set(`${cmd.input.Bucket}/${cmd.input.Key}`, cmd.input.Body ?? '');
            return {};
          }
          const body = storedObjects.get(`${cmd.input.Bucket}/${cmd.input.Key}`);
          if (body === undefined) {
            const notFound = new Error('NoSuchKey') as Error & { name: string };
            notFound.name = 'NoSuchKey';
            throw notFound;
          }
          return {
            Body: {
              transformToString: async () => body,
            },
          };
        },
      ),
    } as unknown as S3Client;

    const missingCache = new BedrockPricingCache({
      s3Bucket: 'roadtrip-app-data',
      s3Client: mockS3,
      now: () => TEST_PRICING_REFRESHED_MS + 1_000,
    });

    await expect(missingCache.getCatalog()).rejects.toMatchObject({
      name: 'PricingUnavailableError',
      statusCode: 503,
    });

    const catalog = makeTestPricingCatalog();
    const writeResult = await missingCache.writeCatalog(catalog);
    expect(writeResult.storageLocation).toBe(`s3://roadtrip-app-data/${PRICING_CACHE_S3_KEY}`);

    const freshReader = new BedrockPricingCache({
      s3Bucket: 'roadtrip-app-data',
      s3Client: mockS3,
      now: () => TEST_PRICING_REFRESHED_MS + 2_000,
    });
    const readResult = await freshReader.getCatalog();
    expect(readResult.catalog).toEqual(catalog);
    expect(readResult.isStale).toBe(false);

    // Corrupt JSON in S3 with no prior in-memory catalog -> 503 PricingUnavailableError
    storedObjects.set(`roadtrip-app-data/${PRICING_CACHE_S3_KEY}`, '{not-json');
    const corruptReader = new BedrockPricingCache({
      s3Bucket: 'roadtrip-app-data',
      s3Client: mockS3,
    });
    await expect(corruptReader.getCatalog()).rejects.toThrow(PricingUnavailableError);
  });

  it('cleans up temporary .tmp.* files when local writeCatalog rename fails and rejects invalid catalog schemas', async () => {
    // Create a directory at the target file path so fs.writeFile(tmpPath) succeeds but fs.rename(tmpPath, localFilePath) fails
    const collidingTargetDir = path.join(tempDir, 'bedrock-us-east-2.json');
    await fs.mkdir(collidingTargetDir, { recursive: true });

    const cache = new BedrockPricingCache({
      s3Bucket: '',
      localFilePath: collidingTargetDir,
      now: () => TEST_PRICING_REFRESHED_MS + 1_000,
    });

    await expect(cache.writeCatalog(makeTestPricingCatalog())).rejects.toThrow();

    const remainingEntries = await fs.readdir(tempDir);
    expect(remainingEntries.filter((entry) => entry.includes('.tmp.'))).toEqual([]);

    // Also verify writeCatalog validates schema before writing
    const invalidCatalog = {
      ...makeTestPricingCatalog(),
      models: {},
    } as unknown as BedrockPricingCatalog;
    await expect(cache.writeCatalog(invalidCatalog)).rejects.toThrow(PricingUnavailableError);
  });

  it('resets retainedAfterFailure when writeCatalog() succeeds after a failed reload', async () => {
    const localFilePath = path.join(tempDir, 'bedrock-us-east-2.json');
    let currentNow = TEST_PRICING_REFRESHED_MS + 1_000;
    const cache = new BedrockPricingCache({
      s3Bucket: '',
      localFilePath,
      now: () => currentNow,
      logger: { warn: vi.fn() },
    });

    await cache.writeCatalog(makeTestPricingCatalog());
    await fs.rm(localFilePath, { force: true });

    // Advance past 5-minute memory TTL so reload fails on missing disk file and retains catalog as stale
    currentNow += PRICING_CACHE_MEMORY_TTL_MS + 1_000;
    const retained = await cache.getCatalog();
    expect(retained.isStale).toBe(true);

    // Writing a fresh catalog resets retainedAfterFailure to false
    await cache.writeCatalog(makeTestPricingCatalog());
    const refreshed = await cache.getCatalog();
    expect(refreshed.isStale).toBe(false);
  });
});
