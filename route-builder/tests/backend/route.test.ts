import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from '../../server/app.js';
import { RouteService, OSRM_SPEED_CALIBRATION_FACTOR, adjustStepDuration } from '../../server/services/routeService.js';
import { RouteCache } from '../../server/services/routeCache.js';
import type { OsrmRawResponse } from '../../server/types/index.js';

describe('OSRM Routing Proxy (/api/routing/route)', () => {
  let app: ReturnType<typeof createApp>;
  let routeCache: RouteCache;
  let routeService: RouteService;

  beforeEach(() => {
    routeCache = new RouteCache();
    routeService = new RouteService(undefined, routeCache);
    app = createApp({ logger: false, routeService });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Scenario 2: Returns HTTP 200 with valid GeoJSON road geometry and drive duration', async () => {
    const mockOsrmResponse: OsrmRawResponse = {
      code: 'Ok',
      routes: [
        {
          distance: 185200, // ~185.2 km (115.08 miles)
          duration: 7200, // 2 hours (120 minutes)
          geometry: {
            type: 'LineString',
            coordinates: [
              [-112.0152, 33.4357],
              [-111.85, 34.12],
              [-111.7645, 34.801],
            ],
          },
          legs: [
            {
              distance: 185200,
              duration: 7200,
              summary: 'I-17 N, AZ-179 N',
            },
          ],
        },
      ],
      waypoints: [
        {
          name: 'PHX Sky Harbor',
          location: [-112.0152, 33.4357],
        },
        {
          name: 'Sedona Bell Rock',
          location: [-111.7645, 34.801],
        },
      ],
    };

    let requestedUrl: string | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      requestedUrl = url.toString();
      return new Response(JSON.stringify(mockOsrmResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const coords = '-112.0152,33.4357;-111.7645,34.801';
    const res = await app.inject({
      method: 'GET',
      url: `/api/routing/route?coords=${encodeURIComponent(coords)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Verify OSRM endpoint URL requested with unencoded delimiters
    expect(requestedUrl).toBeDefined();
    expect(requestedUrl).toContain('overview=full&geometries=geojson');
    expect(requestedUrl).not.toContain('%3B');
    expect(requestedUrl).not.toContain('%2C');
    expect(requestedUrl).toContain(`/${coords}?`);

    // Verify GeoJSON LineString geometry
    expect(body.geometry).toBeDefined();
    expect(body.geometry.type).toBe('LineString');
    expect(Array.isArray(body.geometry.coordinates)).toBe(true);
    expect(body.geometry.coordinates).toHaveLength(3);
    expect(body.geometry.coordinates[0]).toEqual([-112.0152, 33.4357]);
    expect(body.geometry.coordinates[2]).toEqual([-111.7645, 34.801]);

    // Verify distance and drive duration calculations (calibrated for North American driving)
    const expectedDurationSec = Math.round(7200 * OSRM_SPEED_CALIBRATION_FACTOR);
    expect(body.distanceMeters).toBe(185200);
    expect(body.distanceMiles).toBeCloseTo(115.08, 1);
    expect(body.durationSeconds).toBe(expectedDurationSec);
    expect(body.durationMinutes).toBe(Number((expectedDurationSec / 60).toFixed(1)));

    // Verify waypoints
    expect(body.waypoints).toHaveLength(2);
    expect(body.waypoints[0].name).toBe('PHX Sky Harbor');

    // First request should not be from cache
    expect(body.cached).toBe(false);
  });

  it('rejects requests missing coords parameter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/routing/route',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('coords');
  });

  it('rejects requests with fewer than 2 coordinate waypoints', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/routing/route?coords=-112.0152,33.4357',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('at least two coordinate waypoints');
  });

  it('rejects malformed coordinate pairs', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/routing/route?coords=invalid_coord;-111.7645,34.8010',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Invalid waypoint format');
  });

  it('rejects non-numeric coordinates', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/routing/route?coords=abc,def;-111.7645,34.8010',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('must be valid numbers');
  });

  it('rejects coordinates exceeding latitude / longitude boundaries', async () => {
    const resLat = await app.inject({
      method: 'GET',
      url: '/api/routing/route?coords=-112.0152,95.0;-111.7645,34.8010',
    });
    expect(resLat.statusCode).toBe(400);
    expect(resLat.json().error).toContain('Latitude out of bounds');

    const resLon = await app.inject({
      method: 'GET',
      url: '/api/routing/route?coords=-190.0,33.0;-111.7645,34.8010',
    });
    expect(resLon.statusCode).toBe(400);
    expect(resLon.json().error).toContain('Longitude out of bounds');
  });

  it('handles OSRM error codes (e.g. NoRoute) gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          code: 'NoRoute',
          message: 'Impossible route between waypoints across water',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/routing/route?coords=-112.0152,33.4357;-111.7645,34.8010',
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('Impossible route');
  });

  it('handles OSRM server 500 error gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('Internal Server Error', {
        status: 500,
        statusText: 'Internal Server Error',
      });
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/routing/route?coords=-112.0152,33.4357;-111.7645,34.8010',
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('HTTP 500');
  });

  it('supports custom calibration factor parameter (e.g. 1.0 for uncalibrated raw duration)', async () => {
    const mockOsrmResponse: OsrmRawResponse = {
      code: 'Ok',
      routes: [
        {
          distance: 100000,
          duration: 3600,
          geometry: {
            type: 'LineString',
            coordinates: [
              [-112.0, 33.4],
              [-111.7, 34.8],
            ],
          },
          legs: [
            {
              distance: 100000,
              duration: 3600,
              summary: 'Highway',
            },
          ],
        },
      ],
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify(mockOsrmResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/routing/route?coords=-112.0,33.4;-111.7,34.8&calibration=1.0',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.durationSeconds).toBe(3600);
    expect(body.durationMinutes).toBe(60);
  });

  it('rejects invalid non-positive calibration parameter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/routing/route?coords=-112.0,33.4;-111.7,34.8&calibration=-0.5',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('calibration');
  });

  describe('North American Statutory Highway Speed Normalization', () => {
    it('elevates untagged rural US Highway steps (40 mph OSRM default) to statutory 62 mph', () => {
      // 10 miles at 40.4 mph raw OSRM (~891 seconds)
      const distMeters = 16093.44; // 10 miles
      const rawSec = 891; // ~40.4 mph
      const step = {
        distance: distMeters,
        duration: rawSec,
        ref: 'US 60',
        name: 'Historic US Route 60',
      };

      const adjustedSec = adjustStepDuration(step, OSRM_SPEED_CALIBRATION_FACTOR);
      const adjustedMph = 10 / (adjustedSec / 3600);
      expect(adjustedMph).toBeCloseTo(62, 0);
      expect(adjustedSec).toBe(Math.round((10 / 62) * 3600));
    });

    it('elevates untagged rural State Highway steps across all US states to statutory 58 mph', () => {
      const stateRefs = ['AZ 260', 'NY 17', 'CA 1', 'TX 130', 'NC 12', 'FL 417', 'WA 20', 'M 28', 'BC 99'];

      stateRefs.forEach((ref) => {
        const distMeters = 1609.344 * 20; // 20 miles
        const rawSec = 1782; // ~40.4 mph
        const step = {
          distance: distMeters,
          duration: rawSec,
          ref,
          name: 'Highway Segment',
        };

        const adjustedSec = adjustStepDuration(step, OSRM_SPEED_CALIBRATION_FACTOR);
        const adjustedMph = 20 / (adjustedSec / 3600);
        expect(adjustedMph).toBeCloseTo(58, 0);
      });
    });

    it('elevates slow Interstate steps to statutory 70 mph', () => {
      const distMeters = 1609.344 * 15; // 15 miles
      const rawSec = 1080; // 50 mph
      const step = {
        distance: distMeters,
        duration: rawSec,
        ref: 'I 40',
        name: 'Interstate 40',
      };

      const adjustedSec = adjustStepDuration(step, OSRM_SPEED_CALIBRATION_FACTOR);
      const adjustedMph = 15 / (adjustedSec / 3600);
      expect(adjustedMph).toBeCloseTo(70, 0);
    });

    it('preserves standard baseline calibration for urban, short (<1.5 mi), or local streets', () => {
      // Short downtown street: 0.5 miles at 25 mph raw
      const distMeters = 804.672; // 0.5 miles
      const rawSec = 72; // 25 mph
      const step = {
        distance: distMeters,
        duration: rawSec,
        ref: '',
        name: 'Main Street',
      };

      const adjustedSec = adjustStepDuration(step, 0.77);
      expect(adjustedSec).toBe(Math.round(72 * 0.77));
    });
  });
});
