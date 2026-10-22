import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import crypto from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  S3ItineraryStorageService,
  PreconditionFailedError,
} from '../../server/services/itineraryStorageService.js';
import { createApp } from '../../server/app.js';
import { AuthService } from '../../server/services/authService.js';

interface MockS3Object {
  content: string;
  etag: string;
  lastModified: Date;
}

interface S3CommandLike {
  constructor: { name: string };
  input: {
    Bucket?: string;
    Key?: string;
    Prefix?: string;
    IfMatch?: string;
    IfNoneMatch?: string;
    Body?: unknown;
    ContentType?: string;
    [key: string]: unknown;
  };
}

class MockS3Client {
  public store = new Map<string, MockS3Object>();
  public calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  public pageSize?: number;

  async send<T = unknown>(command: unknown): Promise<T> {
    const cmd = command as S3CommandLike;
    const name = cmd.constructor.name;
    const input = cmd.input;
    this.calls.push({ name, input });

    if (name === 'ListObjectsV2Command') {
      const prefix = input.Prefix || '';
      const matchingKeys = Array.from(this.store.keys()).filter((k) => k.startsWith(prefix));
      const limit =
        typeof input.MaxKeys === 'number'
          ? input.MaxKeys
          : this.pageSize && this.pageSize > 0
          ? this.pageSize
          : matchingKeys.length;
      const startIndex =
        typeof input.ContinuationToken === 'string'
          ? parseInt(input.ContinuationToken, 10)
          : 0;
      const pageKeys = matchingKeys.slice(startIndex, startIndex + limit);
      const isTruncated = startIndex + limit < matchingKeys.length;
      const nextContinuationToken = isTruncated ? String(startIndex + limit) : undefined;
      const contents = pageKeys.map((key) => {
        const obj = this.store.get(key)!;
        return {
          Key: key,
          ETag: obj.etag,
          LastModified: obj.lastModified,
          Size: obj.content.length,
        };
      });
      return {
        Contents: contents,
        KeyCount: contents.length,
        IsTruncated: isTruncated,
        NextContinuationToken: nextContinuationToken,
      } as T;
    }

    if (name === 'GetObjectCommand') {
      const key = input.Key || '';
      const obj = this.store.get(key);
      if (!obj) {
        const err = new Error(`NoSuchKey: ${key}`);
        err.name = 'NoSuchKey';
        Object.assign(err, { $metadata: { httpStatusCode: 404 } });
        throw err;
      }
      return {
        Body: {
          transformToString: async () => obj.content,
        },
        ETag: obj.etag,
        LastModified: obj.lastModified,
      } as T;
    }

    if (name === 'PutObjectCommand') {
      const key = input.Key || '';
      const existing = this.store.get(key);

      if (input.IfNoneMatch === '*' && existing) {
        const err = new Error('PreconditionFailed: If-None-Match condition failed');
        err.name = 'PreconditionFailed';
        Object.assign(err, { $metadata: { httpStatusCode: 412 } });
        throw err;
      }

      if (input.IfMatch) {
        if (!existing || existing.etag !== input.IfMatch) {
          const err = new Error('PreconditionFailed: If-Match condition failed');
          err.name = 'PreconditionFailed';
          Object.assign(err, { $metadata: { httpStatusCode: 412 } });
          throw err;
        }
      }

      const content = typeof input.Body === 'string' ? input.Body : String(input.Body);
      const hash = crypto.createHash('md5').update(content).digest('hex');
      const etag = `"${hash}"`;
      const lastModified = new Date();
      this.store.set(key, { content, etag, lastModified });
      return {
        ETag: etag,
      } as T;
    }

    if (name === 'HeadObjectCommand') {
      const key = input.Key || '';
      const obj = this.store.get(key);
      if (!obj) {
        const err = new Error(`NotFound: ${key}`);
        err.name = 'NotFound';
        Object.assign(err, { $metadata: { httpStatusCode: 404 } });
        throw err;
      }
      return {
        ETag: obj.etag,
        LastModified: obj.lastModified,
      } as T;
    }

    if (name === 'DeleteObjectCommand') {
      const key = input.Key || '';
      const existing = this.store.get(key);
      if (input.IfMatch) {
        if (!existing || existing.etag !== input.IfMatch) {
          const err = new Error('PreconditionFailed: If-Match condition failed on delete');
          err.name = 'PreconditionFailed';
          Object.assign(err, { $metadata: { httpStatusCode: 412 } });
          throw err;
        }
      }
      this.store.delete(key);
      return {} as T;
    }

    throw new Error(`Unhandled command: ${name}`);
  }
}

describe('S3ItineraryStorageService & Cloud Persistence', () => {
  let mockS3: MockS3Client;
  let tempFallbackDir: string;

  beforeEach(async () => {
    mockS3 = new MockS3Client();
    tempFallbackDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-s3-test-'));

    // Write a local itinerary outside S3. It is never passed to the service, so the
    // S3 backend must never surface it in lists or reads.
    const localDecoy = {
      trip_name: 'Local Decoy Itinerary',
      checkpoints: [
        { id: '1', name: 'Start', lat: 34.0, lng: -118.0 },
        { id: '2', name: 'End', lat: 36.0, lng: -115.0 },
      ],
    };
    await fs.writeFile(
      path.join(tempFallbackDir, 'local_decoy.json'),
      JSON.stringify(localDecoy, null, 2),
      'utf-8'
    );
  });

  afterEach(async () => {
    await fs.rm(tempFallbackDir, { recursive: true, force: true });
  });

  describe('S3ItineraryStorageService Unit Tests', () => {
    it('requires bucketName option or S3_STORAGE_BUCKET environment variable', () => {
      const orig = process.env.S3_STORAGE_BUCKET;
      delete process.env.S3_STORAGE_BUCKET;

      expect(() => new S3ItineraryStorageService({ bucketName: '' })).toThrow(/requires bucketName/);

      process.env.S3_STORAGE_BUCKET = orig;
    });

    it('sanitizes user email into safe S3 key prefix without namespace collisions', () => {
      const service = new S3ItineraryStorageService({
        bucketName: 'test-bucket',
        s3Client: mockS3 as unknown as S3Client,
      });

      expect(service.getUserPrefix('Driver+Test@Example.COM')).toBe(
        'users/driver+test@example.com/itineraries/'
      );
      expect(service.getUserPrefix('driver_test@example.com')).toBe(
        'users/driver_test@example.com/itineraries/'
      );
      expect(service.getUserPrefix('Driver+Test@Example.COM')).not.toBe(
        service.getUserPrefix('driver_test@example.com')
      );
      expect(service.getUserPrefix(undefined)).toBe('users/local-dev@localhost/itineraries/');
      expect(service.getUserPrefix('normal.user-123@sub.domain.org')).toBe(
        'users/normal.user-123@sub.domain.org/itineraries/'
      );
      expect(service.getUserPrefix('../../malicious@domain.com')).toBe(
        'users/..%2F..%2Fmalicious@domain.com/itineraries/'
      );
    });

    it('lists itineraries scoped to the user prefix', async () => {
      const service = new S3ItineraryStorageService({
        bucketName: 'test-bucket',
        s3Client: mockS3 as unknown as S3Client,
      });

      // Save a route for user1
      await service.saveItinerary(
        'pacific_coast.json',
        {
          trip_name: 'Pacific Coast Highway',
          checkpoints: [{ id: '1', name: 'Monterey', lat: 36.6, lng: -121.9 }],
        },
        { userEmail: 'user1@example.com' }
      );

      // List for user1: exactly the one S3 object, no local fallback file appended
      const listUser1 = await service.listItineraries('user1@example.com');
      expect(listUser1).toHaveLength(1);
      expect(listUser1[0].fileName).toBe('pacific_coast.json');
      expect(listUser1[0].isProtected).toBeFalsy();
      expect(listUser1[0].tripName).toBe('Pacific Coast Highway');
      expect(listUser1[0].etag).toBeDefined();

      // List for user2: isolation, no user1 route and no local fallback file
      const listUser2 = await service.listItineraries('user2@example.com');
      expect(listUser2).toHaveLength(0);
    });

    it('paginates through multiple pages of S3 objects when IsTruncated is true', async () => {
      mockS3.pageSize = 2;
      const service = new S3ItineraryStorageService({
        bucketName: 'test-bucket',
        s3Client: mockS3 as unknown as S3Client,
      });

      for (let i = 1; i <= 5; i++) {
        await service.saveItinerary(
          `trip_${i}.json`,
          { trip_name: `Trip ${i}`, checkpoints: [] },
          { userEmail: 'paginated@example.com' }
        );
      }

      const list = await service.listItineraries('paginated@example.com');
      expect(list).toHaveLength(5);
      const listCalls = mockS3.calls.filter((c) => c.name === 'ListObjectsV2Command');
      expect(listCalls.length).toBeGreaterThanOrEqual(3);
      mockS3.pageSize = undefined;
    });

    it('retrieves user itinerary from S3 with _etag and _lastModified', async () => {
      const service = new S3ItineraryStorageService({
        bucketName: 'test-bucket',
        s3Client: mockS3 as unknown as S3Client,
      });

      const saved = await service.saveItinerary(
        'route66.json',
        { trip_name: 'Historic Route 66', checkpoints: [] },
        { userEmail: 'driver@example.com' }
      );

      const retrieved = await service.getItinerary('route66.json', 'driver@example.com');
      expect(retrieved).toBeDefined();
      expect(retrieved?.trip_name).toBe('Historic Route 66');
      expect(retrieved?._etag).toBe(saved.etag);
      expect(retrieved?._lastModified).toBeDefined();
      expect(retrieved?._isProtected).toBeUndefined();

      // Different user cannot access driver's file
      const notFoundOtherUser = await service.getItinerary('route66.json', 'stranger@example.com');
      expect(notFoundOtherUser).toBeNull();
    });

    it('does not hardcode us-east-1 when region option and AWS_REGION are unset', async () => {
      const origRegion = process.env.AWS_REGION;
      const origProfile = process.env.AWS_PROFILE;
      const origConfigFile = process.env.AWS_CONFIG_FILE;

      const tempConfigFile = path.join(
        os.tmpdir(),
        `aws-config-${Date.now()}-${Math.random().toString(36).slice(2)}.ini`
      );
      await fs.writeFile(
        tempConfigFile,
        '[profile copilot-test-profile]\nregion = eu-west-1\n',
        'utf-8'
      );

      process.env.AWS_CONFIG_FILE = tempConfigFile;
      process.env.AWS_PROFILE = 'copilot-test-profile';
      delete process.env.AWS_REGION;

      try {
        const service = new S3ItineraryStorageService({ bucketName: 'test-bucket' });
        const client = (service as unknown as { client: S3Client }).client;
        expect(await client.config.region()).toBe('eu-west-1');
      } finally {
        if (origRegion !== undefined) process.env.AWS_REGION = origRegion;
        else delete process.env.AWS_REGION;
        if (origProfile !== undefined) process.env.AWS_PROFILE = origProfile;
        else delete process.env.AWS_PROFILE;
        if (origConfigFile !== undefined) process.env.AWS_CONFIG_FILE = origConfigFile;
        else delete process.env.AWS_CONFIG_FILE;
        await fs.unlink(tempConfigFile).catch(() => {});
      }
    });

    it('enforces If-None-Match: * on saveItinerary: rejects when object already exists', async () => {
      const service = new S3ItineraryStorageService({
        bucketName: 'test-bucket',
        s3Client: mockS3 as unknown as S3Client,
      });

      // First write with If-None-Match: * succeeds
      const first = await service.saveItinerary(
        'atomic_trip.json',
        { trip_name: 'Initial Creation' },
        { userEmail: 'driver@example.com', ifNoneMatch: '*' }
      );
      expect(first.success).toBe(true);

      // Second write with If-None-Match: * throws PreconditionFailedError
      await expect(
        service.saveItinerary(
          'atomic_trip.json',
          { trip_name: 'Conflicting Overwrite' },
          { userEmail: 'driver@example.com', ifNoneMatch: '*' }
        )
      ).rejects.toThrow(PreconditionFailedError);
    });

    it('enforces If-Match on saveItinerary: succeeds with matching ETag, rejects on mismatch', async () => {
      const service = new S3ItineraryStorageService({
        bucketName: 'test-bucket',
        s3Client: mockS3 as unknown as S3Client,
      });

      const initial = await service.saveItinerary(
        'matched_trip.json',
        { trip_name: 'Original V1' },
        { userEmail: 'driver@example.com' }
      );

      // Mismatched ETag throws PreconditionFailedError
      await expect(
        service.saveItinerary(
          'matched_trip.json',
          { trip_name: 'Stale Update' },
          { userEmail: 'driver@example.com', ifMatch: '"stale-etag"' }
        )
      ).rejects.toThrow(PreconditionFailedError);

      // Matching ETag succeeds
      const updated = await service.saveItinerary(
        'matched_trip.json',
        { trip_name: 'Updated V2' },
        { userEmail: 'driver@example.com', ifMatch: initial.etag }
      );
      expect(updated.success).toBe(true);
      expect(updated.etag).not.toBe(initial.etag);
    });

    it('deleteItinerary throws 404 error when object does not exist in S3', async () => {
      const service = new S3ItineraryStorageService({
        bucketName: 'test-bucket',
        s3Client: mockS3 as unknown as S3Client,
      });

      await expect(
        service.deleteItinerary('missing.json', { userEmail: 'driver@example.com' })
      ).rejects.toThrow(/not found in writable storage/i);
    });

    it('deleteItinerary enforces If-Match ETag check and deletes on match', async () => {
      const service = new S3ItineraryStorageService({
        bucketName: 'test-bucket',
        s3Client: mockS3 as unknown as S3Client,
      });

      const saved = await service.saveItinerary(
        'deletable.json',
        { trip_name: 'To Delete' },
        { userEmail: 'driver@example.com' }
      );

      // Mismatched ETag throws PreconditionFailedError
      await expect(
        service.deleteItinerary('deletable.json', {
          userEmail: 'driver@example.com',
          ifMatch: '"wrong-etag"',
        })
      ).rejects.toThrow(PreconditionFailedError);

      // Matching ETag succeeds
      const delRes = await service.deleteItinerary('deletable.json', {
        userEmail: 'driver@example.com',
        ifMatch: saved.etag,
      });
      expect(delRes.success).toBe(true);

      // Object is gone from S3
      const check = await service.getItinerary('deletable.json', 'driver@example.com');
      expect(check).toBeNull();

      // Verify DeleteObjectCommand was dispatched with IfMatch
      const delCall = mockS3.calls.find(
        (c) =>
          c.name === 'DeleteObjectCommand' &&
          c.input.Key === 'users/driver@example.com/itineraries/deletable.json'
      );
      expect(delCall).toBeDefined();
      expect(delCall?.input.IfMatch).toBe(saved.etag);
    });

  });

  describe('Fastify Endpoints Integration with S3 Storage & User Auth Scoping', () => {
    let authService: AuthService;
    let s3Service: S3ItineraryStorageService;
    let aliceToken: string;
    let bobToken: string;

    beforeEach(() => {
      authService = new AuthService({
        authEnabled: true,
        jwtSecret: 'test-jwt-secret-for-s3-integration-tests-1234',
        allowedEmails: ['alice@example.com', 'bob@example.com'],
      });

      aliceToken = authService.signSessionToken({
        sub: 'user-alice-sub',
        email: 'alice@example.com',
        name: 'Alice',
      });

      bobToken = authService.signSessionToken({
        sub: 'user-bob-sub',
        email: 'bob@example.com',
        name: 'Bob',
      });

      s3Service = new S3ItineraryStorageService({
        bucketName: 'fastify-test-bucket',
        s3Client: mockS3 as unknown as S3Client,
      });
    });

    it('GET /api/itineraries isolates lists between authenticated users', async () => {
      const app = createApp({
        storageService: s3Service,
        authService,
      });

      // Alice creates a trip
      const postAlice = await app.inject({
        method: 'POST',
        url: '/api/itineraries/alice_mountains.json',
        headers: {
          authorization: `Bearer ${aliceToken}`,
        },
        payload: {
          content: {
            trip_name: "Alice's Mountain Loop",
            checkpoints: [{ id: '1', name: 'Pass', lat: 39.0, lng: -105.0 }],
          },
        },
      });
      expect(postAlice.statusCode).toBe(200);

      // Alice lists itineraries: sees her trip
      const getAlice = await app.inject({
        method: 'GET',
        url: '/api/itineraries',
        headers: {
          authorization: `Bearer ${aliceToken}`,
        },
      });
      expect(getAlice.statusCode).toBe(200);
      const aliceBody = JSON.parse(getAlice.body) as { itineraries: Array<{ fileName: string }> };
      expect(aliceBody.itineraries.map((i) => i.fileName)).toContain('alice_mountains.json');

      // Bob lists itineraries: NEVER Alice's trip, and no locally bundled routes
      const getBob = await app.inject({
        method: 'GET',
        url: '/api/itineraries',
        headers: {
          authorization: `Bearer ${bobToken}`,
        },
      });
      expect(getBob.statusCode).toBe(200);
      const bobBody = JSON.parse(getBob.body) as { itineraries: Array<{ fileName: string }> };
      expect(bobBody.itineraries.map((i) => i.fileName)).not.toContain('alice_mountains.json');
      expect(bobBody.itineraries).toHaveLength(0);
    });

    it('GET /api/itineraries/:filename sets ETag header and isolates by user', async () => {
      const app = createApp({
        storageService: s3Service,
        authService,
      });

      // Alice saves a route
      const postRes = await app.inject({
        method: 'POST',
        url: '/api/itineraries/secret_canyon.json',
        headers: {
          authorization: `Bearer ${aliceToken}`,
        },
        payload: {
          content: { trip_name: 'Secret Canyon' },
        },
      });
      expect(postRes.statusCode).toBe(200);
      const createdEtag = postRes.headers['etag'];
      expect(createdEtag).toBeDefined();

      // Alice reads her route: 200 with matching ETag header
      const getAlice = await app.inject({
        method: 'GET',
        url: '/api/itineraries/secret_canyon.json',
        headers: {
          authorization: `Bearer ${aliceToken}`,
        },
      });
      expect(getAlice.statusCode).toBe(200);
      expect(getAlice.headers['etag']).toBe(createdEtag);
      const body = JSON.parse(getAlice.body) as { trip_name: string; _etag: string };
      expect(body.trip_name).toBe('Secret Canyon');
      expect(body._etag).toBe(createdEtag);

      // Bob tries to read Alice's route: 404 Not Found
      const getBob = await app.inject({
        method: 'GET',
        url: '/api/itineraries/secret_canyon.json',
        headers: {
          authorization: `Bearer ${bobToken}`,
        },
      });
      expect(getBob.statusCode).toBe(404);
    });

    it('POST /api/itineraries/:filename handles ETag conditional writes (412 on race)', async () => {
      const app = createApp({
        storageService: s3Service,
        authService,
      });

      // 1. Initial creation with If-None-Match: *
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/itineraries/desert_oasis.json',
        headers: {
          authorization: `Bearer ${aliceToken}`,
          'if-none-match': '*',
        },
        payload: {
          content: { trip_name: 'Desert Oasis V1' },
        },
      });
      expect(createRes.statusCode).toBe(200);
      const v1Etag = createRes.headers['etag'] as string;

      // 2. Duplicate creation with If-None-Match: * returns 412
      const duplicateRes = await app.inject({
        method: 'POST',
        url: '/api/itineraries/desert_oasis.json',
        headers: {
          authorization: `Bearer ${aliceToken}`,
          'if-none-match': '*',
        },
        payload: {
          content: { trip_name: 'Desert Oasis Conflict' },
        },
      });
      expect(duplicateRes.statusCode).toBe(412);

      // 3. Update with stale If-Match returns 412
      const staleRes = await app.inject({
        method: 'POST',
        url: '/api/itineraries/desert_oasis.json',
        headers: {
          authorization: `Bearer ${aliceToken}`,
          'if-match': '"stale-etag-999"',
        },
        payload: {
          content: { trip_name: 'Desert Oasis Stale' },
        },
      });
      expect(staleRes.statusCode).toBe(412);

      // 4. Update with valid If-Match returns 200 with new ETag
      const validUpdate = await app.inject({
        method: 'POST',
        url: '/api/itineraries/desert_oasis.json',
        headers: {
          authorization: `Bearer ${aliceToken}`,
          'if-match': v1Etag,
        },
        payload: {
          content: { trip_name: 'Desert Oasis V2' },
        },
      });
      expect(validUpdate.statusCode).toBe(200);
      expect(validUpdate.headers['etag']).toBeDefined();
      expect(validUpdate.headers['etag']).not.toBe(v1Etag);
    });

    it('DELETE /api/itineraries/:filename handles If-Match (412 on race)', async () => {
      const app = createApp({
        storageService: s3Service,
        authService,
      });

      // Create a deletable trip
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/itineraries/temp_drive.json',
        headers: {
          authorization: `Bearer ${aliceToken}`,
        },
        payload: {
          content: { trip_name: 'Temporary Drive' },
        },
      });
      expect(createRes.statusCode).toBe(200);
      const etag = createRes.headers['etag'] as string;

      // Delete with wrong ETag returns 412
      const delMismatched = await app.inject({
        method: 'DELETE',
        url: '/api/itineraries/temp_drive.json',
        headers: {
          authorization: `Bearer ${aliceToken}`,
          'if-match': '"obsolete-etag"',
        },
      });
      expect(delMismatched.statusCode).toBe(412);

      // Delete with matching ETag returns 200
      const delMatched = await app.inject({
        method: 'DELETE',
        url: '/api/itineraries/temp_drive.json',
        headers: {
          authorization: `Bearer ${aliceToken}`,
          'if-match': etag,
        },
      });
      expect(delMatched.statusCode).toBe(200);

      // Verify file is gone (404)
      const getDeleted = await app.inject({
        method: 'GET',
        url: '/api/itineraries/temp_drive.json',
        headers: {
          authorization: `Bearer ${aliceToken}`,
        },
      });
      expect(getDeleted.statusCode).toBe(404);
    });
  });
});
