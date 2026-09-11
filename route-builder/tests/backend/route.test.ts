import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from '../../server/app.js';
import { RouteService } from '../../server/services/routeService.js';
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

    // Verify distance and drive duration calculations
    expect(body.distanceMeters).toBe(185200);
    expect(body.distanceMiles).toBeCloseTo(115.08, 1);
    expect(body.durationSeconds).toBe(7200);
    expect(body.durationMinutes).toBe(120);

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
});
