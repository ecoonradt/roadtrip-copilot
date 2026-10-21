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

  async send<T = unknown>(command: unknown): Promise<T> {
    const cmd = command as S3CommandLike;
    const name = cmd.constructor.name;
    const input = cmd.input;
    this.calls.push({ name, input });

    if (name === 'ListObjectsV2Command') {
      const prefix = input.Prefix || '';
      const matchingKeys = Array.from(this.store.keys()).filter((k) => k.startsWith(prefix));
      const contents = matchingKeys.map((key) => {
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
        IsTruncated: false,
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

    // Create a bundled sample_itinerary.json in the fallback directory
    const sample = {
      trip_name: 'Bundled Sample Itinerary',
      checkpoints: [
        { id: '1', name: 'Start', lat: 34.0, lng: -118.0 },
        { id: '2', name: 'End', lat: 36.0, lng: -115.0 },
      ],
    };
    await fs.writeFile(
      path.join(tempFallbackDir, 'sample_itinerary.json'),
      JSON.stringify(sample, null, 2),
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

    it('sanitizes user email into safe S3 key prefix', () => {
      const service = new S3ItineraryStorageService({
        bucketName: 'test-bucket',
        s3Client: mockS3 as unknown as S3Client,
        fallbackDirectories: [tempFallbackDir],
      });

      expect(service.getUserPrefix('Driver+Test@Example.COM')).toBe(
        'users/driver_test@example.com/itineraries/'
      );
      expect(service.getUserPrefix(undefined)).toBe('users/local-dev@localhost/itineraries/');
      expect(service.getUserPrefix('normal.user-123@sub.domain.org')).toBe(
        'users/normal.user-123@sub.domain.org/itineraries/'
      );
    });

    it('lists itineraries scoped to user prefix and appends bundled sample_itinerary.json as protected', async () => {
      const service = new S3ItineraryStorageService({
        bucketName: 'test-bucket',
        s3Client: mockS3 as unknown as S3Client,
        fallbackDirectories: [tempFallbackDir],
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

      // List for user1
      const listUser1 = await service.listItineraries('user1@example.com');
      expect(listUser1).toHaveLength(2);

      const customRoute = listUser1.find((i) => i.fileName === 'pacific_coast.json');
      const sampleRoute = listUser1.find((i) => i.fileName === 'sample_itinerary.json');

      expect(customRoute).toBeDefined();
      expect(customRoute?.isProtected).toBe(false);
      expect(customRoute?.tripName).toBe('Pacific Coast Highway');
      expect(customRoute?.etag).toBeDefined();

      expect(sampleRoute).toBeDefined();
      expect(sampleRoute?.isProtected).toBe(true);
      expect(sampleRoute?.tripName).toBe('Bundled Sample Itinerary');

      // List for user2: should only have the bundled sample, not user1's route
      const listUser2 = await service.listItineraries('user2@example.com');
      expect(listUser2).toHaveLength(1);
      expect(listUser2[0].fileName).toBe('sample_itinerary.json');
    });

    it('retrieves user itinerary from S3 with _etag and _lastModified', async () => {
      const service = new S3ItineraryStorageService({
        bucketName: 'test-bucket',
        s3Client: mockS3 as unknown as S3Client,
        fallbackDirectories: [tempFallbackDir],
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
      expect(retrieved?._isProtected).toBe(false);

      // Different user cannot access driver's file
      const notFoundOtherUser = await service.getItinerary('route66.json', 'stranger@example.com');
      expect(notFoundOtherUser).toBeNull();
    });

    it('retrieves bundled sample_itinerary.json from fallback directory with _isProtected: true when not in S3', async () => {
      const service = new S3ItineraryStorageService({
        bucketName: 'test-bucket',
        s3Client: mockS3 as unknown as S3Client,
        fallbackDirectories: [tempFallbackDir],
      });

      const sample = await service.getItinerary('sample_itinerary.json', 'anybody@example.com');
      expect(sample).toBeDefined();
      expect(sample?.trip_name).toBe('Bundled Sample Itinerary');
      expect(sample?._isProtected).toBe(true);
      expect(sample?._etag).toBeDefined();
    });

    it('enforces If-None-Match: * on saveItinerary: rejects when object already exists', async () => {
      const service = new S3ItineraryStorageService({
        bucketName: 'test-bucket',
        s3Client: mockS3 as unknown as S3Client,
        fallbackDirectories: [tempFallbackDir],
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
        fallbackDirectories: [tempFallbackDir],
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

    it('protects sample_itinerary.json from deletion in S3', async () => {
      const service = new S3ItineraryStorageService({
        bucketName: 'test-bucket',
        s3Client: mockS3 as unknown as S3Client,
        fallbackDirectories: [tempFallbackDir],
      });

      await expect(
        service.deleteItinerary('sample_itinerary.json', { userEmail: 'driver@example.com' })
      ).rejects.toThrow(/Cannot delete protected itinerary/);
    });

    it('deleteItinerary throws 404 error when object does not exist in S3', async () => {
      const service = new S3ItineraryStorageService({
        bucketName: 'test-bucket',
        s3Client: mockS3 as unknown as S3Client,
        fallbackDirectories: [tempFallbackDir],
      });

      await expect(
        service.deleteItinerary('missing.json', { userEmail: 'driver@example.com' })
      ).rejects.toThrow(/not found in writable storage/i);
    });

    it('deleteItinerary enforces If-Match ETag check and deletes on match', async () => {
      const service = new S3ItineraryStorageService({
        bucketName: 'test-bucket',
        s3Client: mockS3 as unknown as S3Client,
        fallbackDirectories: [tempFallbackDir],
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

    it('marks sample_itinerary.json as protected in both list and get when stored in S3', async () => {
      const service = new S3ItineraryStorageService({
        bucketName: 'test-bucket',
        s3Client: mockS3 as unknown as S3Client,
        fallbackDirectories: [tempFallbackDir],
      });

      await service.saveItinerary(
        'sample_itinerary.json',
        { trip_name: 'S3 Stored Sample', checkpoints: [] },
        { userEmail: 'driver@example.com' }
      );

      const list = await service.listItineraries('driver@example.com');
      const sampleItem = list.find((i) => i.fileName === 'sample_itinerary.json');
      expect(sampleItem).toBeDefined();
      expect(sampleItem?.isProtected).toBe(true);

      const retrieved = await service.getItinerary('sample_itinerary.json', 'driver@example.com');
      expect(retrieved).toBeDefined();
      expect(retrieved?._isProtected).toBe(true);
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
        fallbackDirectories: [tempFallbackDir],
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

      // Alice lists itineraries: sees her trip + bundled sample
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
      expect(aliceBody.itineraries.map((i) => i.fileName)).toContain('sample_itinerary.json');

      // Bob lists itineraries: sees only bundled sample, NEVER Alice's trip
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
      expect(bobBody.itineraries.map((i) => i.fileName)).toContain('sample_itinerary.json');
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

    it('DELETE /api/itineraries/:filename protects sample and handles If-Match (412 on race)', async () => {
      const app = createApp({
        storageService: s3Service,
        authService,
      });

      // Delete sample_itinerary.json returns 403 Forbidden
      const delSample = await app.inject({
        method: 'DELETE',
        url: '/api/itineraries/sample_itinerary.json',
        headers: {
          authorization: `Bearer ${aliceToken}`,
        },
      });
      expect(delSample.statusCode).toBe(403);

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
