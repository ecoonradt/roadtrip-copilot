import http from 'node:http';
import https from 'node:https';
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';
import {
  SCOUT_TOOL_DECLARATIONS,
  cleanPlaceName,
  assertSafeExternalUrl,
  assertSafeExternalUrlWithDns,
  resolveValidatedUrlWithDns,
  parseHighwayDesignators,
  matchesHighwayRoadName,
  htmlToReadableText,
  ScoutToolLibrary,
  createTurnGroundingCache,
  type ResolvedPlaceRecord,
  type TurnGroundingCache,
  type ScoutToolExecutionContext,
} from './scoutTools.js';
import {
  ScoutService,
  parseScoutResponse,
  hydrateSuggestionFromResolvedPlaces,
  matchResolvedPlaceForSuggestion,
  isInTransitOrAnchorSuggestion,
  isValidGooglePlaceId,
} from './scoutService.js';
import { formatBedrockToolLabel, AwsBedrockHarnessAdapter } from '../ai/bedrock/bedrockService.js';
import { RouteService } from '../routeService.js';
import { AiService, type AiHarnessAdapter } from '../ai/aiService.js';
import type { ScoutTripContext, ScoutChatRequest, ScoutStreamEvent } from '../../types/scout.js';

const sampleTripContext: ScoutTripContext = {
  tripName: 'Arizona Scenic Highway Run',
  date: '2026-10-10',
  origin: 'Phoenix, AZ',
  destination: 'Flagstaff, AZ',
  departureTime: '08:00:00',
  corridor: 'I-17 North to AZ-179 North to US-89A North',
  waypoints: [
    {
      id: 'wp_origin',
      name: 'Phoenix Departure',
      type: 'origin',
      lat: 33.4484,
      lng: -112.074,
      target_time: '08:00:00',
      dwell_minutes: 0,
    },
    {
      id: 'wp_bell_rock',
      name: 'Bell Rock Scenic Vista',
      type: 'scenic_drive_by',
      lat: 34.8005,
      lng: -111.7667,
      target_time: '10:00:00',
      dwell_minutes: 0,
      trigger_radius_miles: 2.0,
      drive_distance_miles: 100,
      drive_duration_minutes: 100,
      drive_speed_mph: 60,
      is_route_anchor: true,
      notification: {
        title: 'Approaching Bell Rock',
        message: 'Approaching Bell Rock Vista along AZ-179.',
        speech: 'Approaching Bell Rock Scenic Vista ahead on your left.',
      },
    },
    {
      id: 'wp_sedona_lunch',
      name: 'Sedona Cafe',
      type: 'meal',
      lat: 34.8697,
      lng: -111.761,
      target_time: '10:30:00',
      dwell_minutes: 45,
      place_name: 'Sedona Cafe',
      address: '100 Main St, Sedona, AZ 86336',
      google_place_id: 'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q',
      drive_distance_miles: 5,
      drive_duration_minutes: 10,
      drive_speed_mph: 30,
      is_route_anchor: false,
      notification: {
        title: 'Sedona Cafe Ahead',
        message: 'Arriving at Sedona Cafe for lunch.',
        speech: 'Approaching Sedona Cafe ahead for lunch.',
      },
    },
    {
      id: 'wp_dest',
      name: 'Flagstaff Lodging',
      type: 'lodging',
      lat: 35.1983,
      lng: -111.6513,
      target_time: '12:30:00',
      dwell_minutes: 0,
      place_name: 'Flagstaff Motor Inn',
      address: '200 Route 66, Flagstaff, AZ 86001',
      google_place_id: 'ChIJCR3fWhuQO4cRxCLXXbAfCxQ',
      drive_distance_miles: 30,
      drive_duration_minutes: 45,
      drive_speed_mph: 40,
      is_route_anchor: false,
    },
  ],
};

describe('Route Scout web search, secret loading, and place resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
  });

  describe('3. search_web & Lazy SSM Secret Resolution', () => {
    it('search_web sends request to Brave Search with X-Subscription-Token and clamps count to [1, 10]', async () => {
      let capturedUrl = '';
      let capturedHeaders: HeadersInit | undefined = undefined;

      const mockFetch: typeof fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        capturedHeaders = init?.headers;
        return new Response(
          JSON.stringify({
            web: {
              results: [
                {
                  title: 'Sedona Scenic Byway',
                  url: 'https://example.com/sedona',
                  description: 'A 7.5-mile scenic highway through Red Rock Country.',
                },
              ],
            },
          }),
          { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }
        );
      });

      const toolLib = new ScoutToolLibrary({
        braveSearchApiKey: 'test-brave-key-123',
        fetchImpl: mockFetch,
      });
      const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

      // Test with count: 20 (should clamp to 10)
      const res1 = await toolLib.searchWeb({ query: 'Sedona byways', count: 20 }, context);
      expect(capturedUrl).toBe('https://api.search.brave.com/res/v1/web/search?q=Sedona%20byways&count=10');
      expect((capturedHeaders as any)?.['X-Subscription-Token']).toBe('test-brave-key-123');
      expect(res1.results).toHaveLength(1);
      expect(res1.results[0].title).toBe('Sedona Scenic Byway');

      // Test with count: 0 (should clamp to 1)
      await toolLib.searchWeb({ query: 'Flagstaff motels', count: 0 }, context);
      expect(capturedUrl).toBe('https://api.search.brave.com/res/v1/web/search?q=Flagstaff%20motels&count=1');
    });

    it('resolves Brave key from SSM, caches for 15 minutes, and enforces 30s cooldown on failure', async () => {
      const mockSend = vi.fn().mockResolvedValue({
        Parameters: [
          { Name: '/roadtrip-copilot/brave-search-api-key', Value: 'ssm-resolved-brave-key' },
        ],
      });
      const mockSsmClient = { send: mockSend } as unknown as SSMClient;

      const mockFetch: typeof fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        if (headers['X-Subscription-Token'] !== 'ssm-resolved-brave-key') {
          return new Response('Unauthorized', { status: 401 });
        }
        return new Response(JSON.stringify({ web: { results: [] } }), {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      });

      const toolLib = new ScoutToolLibrary({
        ssmClient: mockSsmClient,
        fetchImpl: mockFetch,
      });
      const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

      // Call 1: triggers SSM resolution
      await toolLib.searchWeb({ query: 'Query 1' }, context);
      expect(mockSend).toHaveBeenCalledTimes(1);

      // Call 2: uses cached key within 15 minutes (mockSend NOT called again)
      await toolLib.searchWeb({ query: 'Query 2' }, context);
      expect(mockSend).toHaveBeenCalledTimes(1);

      // Now test cooldown behavior when SSM resolution fails:
      const failingSsmSend = vi.fn().mockRejectedValue(new Error('SSM Access Denied'));
      const failingSsmClient = { send: failingSsmSend } as unknown as SSMClient;
      const failingToolLib = new ScoutToolLibrary({
        ssmClient: failingSsmClient,
        fetchImpl: mockFetch,
      });

      // Call 1 on failing lib: fails with SSM error
      await expect(
        failingToolLib.searchWeb({ query: 'Query Fail' }, context)
      ).rejects.toThrow('SSM Access Denied');
      expect(failingSsmSend).toHaveBeenCalledTimes(1);

      // Call 2 within 30s: fails immediately with cooldown error without calling SSM again
      await expect(
        failingToolLib.searchWeb({ query: 'Query Fail Again' }, context)
      ).rejects.toThrow(/in retry cooldown/);
      expect(failingSsmSend).toHaveBeenCalledTimes(1);
    });

    it('fails loudly without silent fallback when Brave API returns HTTP 429 or 500', async () => {
      const mockFetch429: typeof fetch = vi.fn(async () => {
        return new Response('Rate limit exceeded', { status: 429 });
      });

      const toolLib429 = new ScoutToolLibrary({
        braveSearchApiKey: 'key',
        fetchImpl: mockFetch429,
      });
      const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

      await expect(
        toolLib429.searchWeb({ query: 'Sedona hikes' }, context)
      ).rejects.toThrow('Brave Search API failed with HTTP 429');

      const mockFetch500: typeof fetch = vi.fn(async () => {
        return new Response('Internal Server Error', { status: 500 });
      });
      const toolLib500 = new ScoutToolLibrary({
        braveSearchApiKey: 'key',
        fetchImpl: mockFetch500,
      });

      await expect(
        toolLib500.searchWeb({ query: 'Sedona hikes' }, context)
      ).rejects.toThrow('Brave Search API failed with HTTP 500');
    });

    it('never invokes SSM for tools that do not require API keys', async () => {
      const mockSend = vi.fn();
      const mockSsmClient = { send: mockSend } as unknown as SSMClient;

      const mockFetch: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (urlStr.includes('router.project-osrm.org/nearest')) {
          return new Response(
            JSON.stringify({
              code: 'Ok',
              waypoints: [{ name: 'AZ-179', location: [-111.7667, 34.8005], distance: 10 }],
            }),
            { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }
          );
        }
        if (urlStr.includes('example.com/guide')) {
          return new Response('<title>Guide</title><p>Hello World</p>', {
            status: 200,
            headers: new Headers({ 'content-type': 'text/html' }),
          });
        }
        return new Response('{}', { status: 200 });
      });

      const mockRouteService = {
        getRoute: vi.fn().mockResolvedValue({
          distanceMiles: 15,
          durationMinutes: 20,
        }),
      } as unknown as RouteService;

      const toolLib = new ScoutToolLibrary({
        ssmClient: mockSsmClient,
        fetchImpl: mockFetch,
        routeService: mockRouteService,
      });
      const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

      // Execute all 5 tools that do not require API keys
      await toolLib.readUrlContent({ url: 'https://example.com/guide' }, context);
      await toolLib.snapToHighwayCorridor({ lat: 34.8005, lng: -111.7667 }, context);
      await toolLib.calculateDetourImpact(
        { candidate_lat: 34.85, candidate_lng: -111.75, after_waypoint_id: 'wp_bell_rock' },
        context
      );
      await toolLib.simulateScheduleCascade(
        { action: 'add', target_waypoint_id: 'wp_bell_rock', candidate_lat: 34.85, candidate_lng: -111.75 },
        context
      );
      await toolLib.auditCorridorWaypoints({}, context);

      // Verify SSM send was NEVER called
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('resolves AWS region without hardcoded us-east-1 fallback', async () => {
      // 1. Explicit options region
      const libOptions = new ScoutToolLibrary({ region: 'us-east-2' });
      const clientOptions = (libOptions as unknown as { getSsmClient: () => SSMClient }).getSsmClient();
      expect(await clientOptions.config.region()).toBe('us-east-2');

      // 2. process.env.AWS_REGION
      process.env.AWS_REGION = 'eu-west-1';
      const libEnv = new ScoutToolLibrary({});
      const clientEnv = (libEnv as unknown as { getSsmClient: () => SSMClient }).getSsmClient();
      expect(await clientEnv.config.region()).toBe('eu-west-1');
    });
  });

  describe('4. resolve_and_standardize_place (Google Places API New)', () => {
    it('sends POST to Google Places API (New) with field mask and clamps radius to 50000m', async () => {
      let capturedUrl = '';
      let capturedHeaders: HeadersInit | undefined = undefined;
      let capturedBody: Record<string, unknown> | undefined = undefined;

      const mockFetch: typeof fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        capturedHeaders = init?.headers;
        if (init?.body) {
          capturedBody = JSON.parse(init.body as string);
        }

        return new Response(
          JSON.stringify({
            places: [
              {
                id: 'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q',
                displayName: { text: 'Maverik (West Main St)' },
                formattedAddress: '123 Main St, Flagstaff, AZ 86001',
                location: { latitude: 35.1983, longitude: -111.6513 },
                types: ['gas_station', 'convenience_store'],
              },
            ],
          }),
          { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }
        );
      });

      const toolLib = new ScoutToolLibrary({
        googlePlacesApiKey: 'test-google-key-456',
        fetchImpl: mockFetch,
      });

      const groundingCache = createTurnGroundingCache(sampleTripContext.waypoints);
      const context: ScoutToolExecutionContext = {
        tripContext: sampleTripContext,
        groundingCache,
      };

      // Call with radius_miles: 100 (which exceeds 50km hard limit)
      const res = await toolLib.resolveAndStandardizePlace(
        {
          query: 'Maverik Flagstaff',
          lat: 35.1983,
          lng: -111.6513,
          radius_miles: 100,
        },
        context
      );

      expect(capturedUrl).toBe('https://places.googleapis.com/v1/places:searchText');
      const headers = (capturedHeaders as any) as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['X-Goog-Api-Key']).toBe('test-google-key-456');
      expect(headers['X-Goog-FieldMask']).toBe(
        'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.regularOpeningHours'
      );

      // Verify locationBias radius was clamped to exactly 50,000 meters
      const bias = (capturedBody as any)?.locationBias as { circle: { center: { latitude: number; longitude: number }; radius: number } };
      expect(bias).toBeDefined();
      expect(bias.circle.radius).toBe(50000);
      expect(bias.circle.center.latitude).toBe(35.1983);
      expect(bias.circle.center.longitude).toBe(-111.6513);

      // Verify cleaned place name and valid Place ID
      expect(res.places).toHaveLength(1);
      const place = res.places[0];
      expect(place.place_name).toBe('Maverik'); // Parens stripped
      expect(place.display_name).toBe('Maverik (West Main St)');
      expect(place.google_place_id).toBe('ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q');

      // Verify grounding cache was populated
      expect(groundingCache.resolvedPlaces).toHaveLength(1);
      expect(groundingCache.knownPlaceIds.has('ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q')).toBe(true);
    });

    it('strips fake/invalid Google Place IDs and does not add them to knownPlaceIds', async () => {
      const mockFetch: typeof fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            places: [
              {
                id: 'ChIJ_invalid_fake_id_12345', // Fails binary protobuf structural check
                displayName: { text: 'Mystery Diner' },
                formattedAddress: '404 Lost Hwy, Nowhere, AZ',
                location: { latitude: 35.0, longitude: -111.0 },
              },
            ],
          }),
          { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }
        );
      });

      const toolLib = new ScoutToolLibrary({
        googlePlacesApiKey: 'test-key',
        fetchImpl: mockFetch,
      });

      const groundingCache = createTurnGroundingCache();
      const context: ScoutToolExecutionContext = {
        tripContext: sampleTripContext,
        groundingCache,
      };

      const res = await toolLib.resolveAndStandardizePlace({ query: 'Mystery Diner' }, context);
      expect(res.places[0].google_place_id).toBeUndefined();
      expect(groundingCache.knownPlaceIds.has('ChIJ_invalid_fake_id_12345')).toBe(false);
    });

    it('fails loudly without silent fallback or mock places on HTTP 403 or 500', async () => {
      const mockFetch403: typeof fetch = vi.fn(async () => {
        return new Response('Forbidden: API key expired', { status: 403 });
      });

      const toolLib = new ScoutToolLibrary({
        googlePlacesApiKey: 'expired-key',
        fetchImpl: mockFetch403,
      });
      const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

      await expect(
        toolLib.resolveAndStandardizePlace({ query: 'Sedona Cafe' }, context)
      ).rejects.toThrow('Google Places API failed with HTTP 403');
    });
  });

    it('isolates shared SSM loadPromise from individual caller abort so concurrent caller succeeds without cooldown', async () => {
      delete process.env.BRAVE_SEARCH_API_KEY;
      let resolveSsm!: (value: unknown) => void;
      const ssmSend = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSsm = resolve;
          })
      );
      const mockSsmClient = { send: ssmSend } as unknown as SSMClient;
      const toolLib = new ScoutToolLibrary({ ssmClient: mockSsmClient });

      const callerAAbort = new AbortController();
      const callerBAbort = new AbortController();

      const pA = toolLib.resolveBraveSearchApiKey(callerAAbort.signal);
      const pB = toolLib.resolveBraveSearchApiKey(callerBAbort.signal);

      // Caller A aborts while SSM request is in flight
      callerAAbort.abort();
      await expect(pA).rejects.toThrow('Request aborted');

      // SSM finishes and resolves key for Caller B
      resolveSsm({
        Parameters: [{ Name: '/roadtrip-copilot/brave-search-api-key', Value: 'ssm-shared-brave-key' }],
      });

      await expect(pB).resolves.toBe('ssm-shared-brave-key');
      expect(ssmSend).toHaveBeenCalledTimes(1);
    });
    it('resolve_and_standardize_place rejects partial or out-of-range coordinates and filters groundingCache to query matches', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            places: [
              {
                id: 'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q',
                displayName: { text: 'Maverik Adventure Stop' },
                formattedAddress: '1000 W Route 66, Flagstaff, AZ',
                location: { latitude: 35.195, longitude: -111.665 },
              },
              {
                id: 'ChIJCR3fWhuQO4cRxCLXXbAfCxQ',
                displayName: { text: 'Unrelated Tire Shop' },
                formattedAddress: '1002 W Route 66, Flagstaff, AZ',
                location: { latitude: 35.1952, longitude: -111.6652 },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

      const toolLib = new ScoutToolLibrary({
        googlePlacesApiKey: 'test-places-key',
        fetchImpl: mockFetch,
      });
      const cache = createTurnGroundingCache();

      // Reject partial lat without lng (F-13)
      await expect(
        toolLib.resolveAndStandardizePlace(
          { query: 'Maverik', lat: 35.195 },
          { tripContext: sampleTripContext, groundingCache: cache }
        )
      ).rejects.toThrow(/both "lat" and "lng" must be provided together/i);

      // Reject negative radius_miles (F-14)
      await expect(
        toolLib.resolveAndStandardizePlace(
          { query: 'Maverik', lat: 35.195, lng: -111.665, radius_miles: -5 },
          { tripContext: sampleTripContext, groundingCache: cache }
        )
      ).rejects.toThrow(/Invalid radius_miles/);

      // Valid call: caches best_match + query-matching places, excluding unrelated distractor from groundingCache (F-15)
      await toolLib.resolveAndStandardizePlace(
        { query: 'Maverik', lat: 35.195, lng: -111.665 },
        { tripContext: sampleTripContext, groundingCache: cache }
      );
      expect(cache.resolvedPlaces).toHaveLength(1);
      expect(cache.resolvedPlaces[0].place_name).toBe('Maverik Adventure Stop');
    });
    it('disambiguates same-name branches across cities and within cities, and overwrites fabricated model metadata with authoritative record fields', () => {
      const flagstaffMaverik: ResolvedPlaceRecord = {
        query: 'Maverik Flagstaff',
        place_name: 'Maverik',
        display_name: 'Maverik Adventure’s First Stop',
        address: '1000 W Route 66, Flagstaff, AZ 86001',
        lat: 35.1983,
        lng: -111.6513,
        google_place_id: 'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q',
      };
      const sedonaMaverik: ResolvedPlaceRecord = {
        query: 'Maverik Sedona',
        place_name: 'Maverik',
        display_name: 'Maverik Adventure’s First Stop',
        address: '200 W State Route 89A, Sedona, AZ 86336',
        lat: 34.865,
        lng: -111.763,
        google_place_id: 'ChIJCR3fWhuQO4cRxCLXXbAfCxQ',
      };
      const flagstaffEastMaverik: ResolvedPlaceRecord = {
        query: 'Maverik East Flagstaff',
        place_name: 'Maverik',
        display_name: 'Maverik Adventure’s First Stop',
        address: '2500 E Lucky Ln, Flagstaff, AZ 86004',
        lat: 35.205,
        lng: -111.615,
        google_place_id: 'ChIJ2wW_a80KK4cR24D7xO_z5Y4',
      };

      const knownIds = new Set([
        flagstaffMaverik.google_place_id!,
        sedonaMaverik.google_place_id!,
        flagstaffEastMaverik.google_place_id!,
      ]);

      // 3A. Sedona Maverik suggestion selects Sedona branch regardless of resolution order ([Flagstaff, Sedona] vs [Sedona, Flagstaff])
      for (const order of [
        [flagstaffMaverik, sedonaMaverik],
        [sedonaMaverik, flagstaffMaverik],
      ]) {
        const hydrated = hydrateSuggestionFromResolvedPlaces(
          {
            id: 'sug_sedona_fuel',
            action: 'add_waypoint',
            name: 'Maverik Fuel Stop',
            place_name: 'Maverik',
            type: 'fuel',
            lat: 34.8697,
            lng: -111.761,
            dwell_minutes: 15,
            reason: 'Refuel in Sedona.',
          },
          order,
          knownIds
        );
        expect(hydrated.google_place_id).toBe(sedonaMaverik.google_place_id);
        expect(hydrated.address).toBe(sedonaMaverik.address);
        expect(hydrated.lat).toBe(sedonaMaverik.lat);
        expect(hydrated.lng).toBe(sedonaMaverik.lng);
      }

      // 3B. When ONLY Flagstaff Maverik was resolved, a Sedona Maverik suggestion is left unhydrated rather than moved 23.5 miles to Flagstaff
      const unhydratedWrongCity = hydrateSuggestionFromResolvedPlaces(
        {
          id: 'sug_sedona_only',
          action: 'add_waypoint',
          name: 'Maverik Fuel Stop',
          place_name: 'Maverik',
          type: 'fuel',
          lat: 34.8697,
          lng: -111.761,
          dwell_minutes: 15,
          reason: 'Refuel in Sedona.',
        },
        [flagstaffMaverik],
        knownIds
      );
      expect(unhydratedWrongCity.google_place_id).toBeUndefined();
      expect(unhydratedWrongCity.address).toBeUndefined();
      expect(unhydratedWrongCity.lat).toBe(34.8697);
      expect(unhydratedWrongCity.lng).toBe(-111.761);

      // 3C. Two branches in the same city with ambiguous midpoint coordinates and no address qualifier -> left unhydrated
      const ambiguousSameCity = hydrateSuggestionFromResolvedPlaces(
        {
          id: 'sug_flag_ambig',
          action: 'add_waypoint',
          name: 'Maverik Fuel Stop',
          place_name: 'Maverik',
          type: 'fuel',
          lat: 35.2015,
          lng: -111.633,
          dwell_minutes: 15,
          reason: 'Refuel in Flagstaff.',
        },
        [flagstaffMaverik, flagstaffEastMaverik],
        knownIds
      );
      expect(ambiguousSameCity.google_place_id).toBeUndefined();
      expect(ambiguousSameCity.address).toBeUndefined();

      // 3D. Same two branches disambiguated by street qualifier token ("Lucky")
      const disambiguatedByQualifier = hydrateSuggestionFromResolvedPlaces(
        {
          id: 'sug_flag_lucky',
          action: 'update_waypoint',
          targetWaypointId: 'wp_sedona_lunch',
          name: 'Maverik (Lucky Ln)',
          place_name: 'Maverik',
          type: 'fuel',
          lat: 35.2015,
          lng: -111.633,
          dwell_minutes: 15,
          reason: 'Update to East Flagstaff Maverik.',
        },
        [flagstaffMaverik, flagstaffEastMaverik],
        knownIds
      );
      expect(disambiguatedByQualifier.google_place_id).toBe(flagstaffEastMaverik.google_place_id);
      expect(disambiguatedByQualifier.address).toBe(flagstaffEastMaverik.address);

      // 3E. Coordinate backfill in parseScoutResponse when lat/lng omitted on update_waypoint uses target waypoint's city coordinates
      const rawOmittedCoords = `Updating stop in Sedona:
\`\`\`json:suggestions
[
  {
    "action": "update_waypoint",
    "targetWaypointId": "wp_sedona_lunch",
    "name": "Maverik Fuel Stop",
    "place_name": "Maverik",
    "type": "fuel",
    "dwell_minutes": 15,
    "reason": "Switch Sedona stop to Maverik."
  }
]
\`\`\``;
      const backfilledParsed = parseScoutResponse(rawOmittedCoords, {
        resolvedPlaces: [flagstaffMaverik, sedonaMaverik],
        knownPlaceIds: knownIds,
        tripWaypoints: sampleTripContext.waypoints,
      });
      expect(backfilledParsed.suggestions).toHaveLength(1);
      expect(backfilledParsed.suggestions[0].google_place_id).toBe(sedonaMaverik.google_place_id);
      expect(backfilledParsed.suggestions[0].address).toBe(sedonaMaverik.address);
      expect(backfilledParsed.suggestions[0].lat).toBe(sedonaMaverik.lat);
      expect(backfilledParsed.suggestions[0].lng).toBe(sedonaMaverik.lng);

      // Exact Place ID match with fabricated model place_name/address overwrites with authoritative record fields
      const fabricatedMetaSug = hydrateSuggestionFromResolvedPlaces(
        {
          id: 'sug_fabricated',
          action: 'add_waypoint',
          name: 'Stop',
          place_name: 'Hallucinated Wrong Bistro Name',
          address: '9999 Invented Wrong Ave, Nowhere, AZ 00000',
          google_place_id: sedonaMaverik.google_place_id,
          type: 'fuel',
          lat: 34.86,
          lng: -111.76,
          dwell_minutes: 15,
          reason: 'Exact ID match.',
        },
        [flagstaffMaverik, sedonaMaverik],
        knownIds
      );
      expect(fabricatedMetaSug.place_name).toBe('Maverik');
      expect(fabricatedMetaSug.address).toBe('200 W State Route 89A, Sedona, AZ 86336');
      expect(fabricatedMetaSug.lat).toBe(sedonaMaverik.lat);
      expect(fabricatedMetaSug.lng).toBe(sedonaMaverik.lng);

      // Empty record fields never overwrite existing non-empty suggestion metadata
      const sparseRecord: ResolvedPlaceRecord = {
        query: 'Sparse Stop',
        place_name: '   ',
        display_name: 'Sparse Stop',
        address: '',
        lat: 34.865,
        lng: -111.763,
        google_place_id: 'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q',
      };
      const sparseHydrated = hydrateSuggestionFromResolvedPlaces(
        {
          id: 'sug_sparse',
          action: 'add_waypoint',
          name: 'Fallback Name',
          place_name: 'Preserved Place Name',
          address: 'Preserved 123 Main St',
          google_place_id: sparseRecord.google_place_id,
          type: 'meal',
          lat: 34.865,
          lng: -111.763,
          dwell_minutes: 30,
          reason: 'Keep non-empty fields when record is blank.',
        },
        [sparseRecord],
        knownIds
      );
      expect(sparseHydrated.place_name).toBe('Preserved Place Name');
      expect(sparseHydrated.address).toBe('Preserved 123 Main St');
    });
});
