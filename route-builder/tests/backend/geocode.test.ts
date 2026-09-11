import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from '../../server/app.js';
import { GeocodeService, NOMINATIM_USER_AGENT } from '../../server/services/geocodeService.js';
import type { NominatimRawResult } from '../../server/types/index.js';

describe('Nominatim Geocoding Proxy (/api/routing/geocode)', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp({ logger: false });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Scenario 1: Sets a valid User-Agent header and parses location coordinates correctly', async () => {
    const mockNominatimResponse: NominatimRawResult[] = [
      {
        place_id: 12345,
        lat: '35.198284',
        lon: '-111.651299',
        display_name: 'Flagstaff, Coconino County, Arizona, USA',
        boundingbox: ['35.12', '35.25', '-111.75', '-111.55'],
      },
    ];

    let capturedHeaders: Record<string, string> | undefined;
    let capturedUrl: string | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = url.toString();
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      return new Response(JSON.stringify(mockNominatimResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/routing/geocode?q=Flagstaff,+AZ',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Verify User-Agent header compliance
    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders?.['User-Agent']).toBe(NOMINATIM_USER_AGENT);
    expect(capturedHeaders?.['User-Agent']).toContain('RoadtripCoPilotRouteBuilder');

    // Verify request URL
    expect(capturedUrl).toContain('format=json');
    expect(capturedUrl).toContain('Flagstaff');

    // Verify parsed coordinate payload
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({
      lat: 35.198284,
      lng: -111.651299,
      displayName: 'Flagstaff, Coconino County, Arizona, USA',
      boundingBox: [35.12, 35.25, -111.75, -111.55],
    });
    expect(typeof body[0].lat).toBe('number');
    expect(typeof body[0].lng).toBe('number');
  });

  it('rejects requests with missing or whitespace-only query parameter', async () => {
    const resMissing = await app.inject({
      method: 'GET',
      url: '/api/routing/geocode',
    });
    expect(resMissing.statusCode).toBe(400);
    expect(resMissing.json().error).toContain('required');

    const resEmpty = await app.inject({
      method: 'GET',
      url: '/api/routing/geocode?q=%20%20',
    });
    expect(resEmpty.statusCode).toBe(400);
    expect(resEmpty.json().error).toContain('required');
  });

  it('handles Nominatim HTTP 429 rate limit gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('Rate limit exceeded', {
        status: 429,
        statusText: 'Too Many Requests',
      });
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/routing/geocode?q=Sedona',
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().error).toContain('rate limit');
  });

  it('handles upstream 500 error gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response('Internal Server Error', {
        status: 500,
        statusText: 'Internal Server Error',
      });
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/routing/geocode?q=Sedona',
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('Nominatim geocoding failed with status: 500');
  });

  it('handles network / fetch throw gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('DNS resolution failed'));

    const res = await app.inject({
      method: 'GET',
      url: '/api/routing/geocode?q=Sedona',
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('DNS resolution failed');
  });

  it('handles malformed non-array upstream response', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ error: 'invalid format' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/routing/geocode?q=Sedona',
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('Invalid response format');
  });
});
