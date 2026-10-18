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

  it('Scenario 2: Extracts establishment name, Google Maps placeName, clean address, and category for POIs', async () => {
    const mockNominatimResponse: NominatimRawResult[] = [
      {
        place_id: 323353941,
        lat: '37.9726645',
        lon: '-122.0402625',
        class: 'shop',
        type: 'pet',
        name: 'PetSmart',
        display_name: 'PetSmart, 1700, Willow Pass Road, Concord, Contra Costa County, California, 94520, United States',
        address: {
          shop: 'PetSmart',
          house_number: '1700',
          road: 'Willow Pass Road',
          city: 'Concord',
          state: 'California',
          'ISO3166-2-lvl4': 'US-CA',
          postcode: '94520',
          country: 'United States',
          country_code: 'us',
        },
      },
    ];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify(mockNominatimResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/routing/geocode?q=PetSmart',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({
      lat: 37.9726645,
      lng: -122.0402625,
      displayName: 'PetSmart, 1700, Willow Pass Road, Concord, Contra Costa County, California, 94520, United States',
      name: 'PetSmart',
      placeName: 'PetSmart',
      address: '1700 Willow Pass Road, Concord, CA 94520',
      category: 'stop',
    });
  });

  it('Scenario 3: Extracts clean street address and placeName for street address queries without breaking on house numbers', async () => {
    const mockNominatimResponse: NominatimRawResult[] = [
      {
        place_id: 355370122,
        lat: '42.6525800',
        lon: '-73.7562300',
        class: 'building',
        type: 'house',
        name: '',
        display_name: '100, State Street, Downtown, Albany, Albany County, New York, 12207, United States',
        address: {
          house_number: '100',
          road: 'State Street',
          city: 'Albany',
          state: 'New York',
          'ISO3166-2-lvl4': 'US-NY',
          postcode: '12207',
          country: 'United States',
          country_code: 'us',
        },
      },
    ];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify(mockNominatimResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/routing/geocode?q=100+State+St',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({
      lat: 42.65258,
      lng: -73.75623,
      displayName: '100, State Street, Downtown, Albany, Albany County, New York, 12207, United States',
      name: '100 State Street',
      placeName: '100 State Street',
      address: '100 State Street, Albany, NY 12207',
      category: 'scenic_pull_off',
    });
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
