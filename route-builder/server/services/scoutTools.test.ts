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
import { formatBedrockToolLabel, AwsBedrockHarnessAdapter } from './ai/bedrock/bedrockService.js';
import { RouteService } from './routeService.js';
import { AiService, type AiHarnessAdapter } from './ai/aiService.js';
import type { ScoutTripContext, ScoutChatRequest, ScoutStreamEvent } from '../types/scout.js';

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

describe('Route Scout tool declarations, hydration, and isolation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
  });

  describe('1. SCOUT_TOOL_DECLARATIONS & cleanPlaceName', () => {
    it('exports all 7 canonical Route Scout tool declarations with valid JSON schemas', () => {
      expect(SCOUT_TOOL_DECLARATIONS).toHaveLength(7);

      const expectedToolNames = [
        'search_web',
        'read_url_content',
        'resolve_and_standardize_place',
        'snap_to_highway_corridor',
        'calculate_detour_impact',
        'simulate_schedule_cascade',
        'audit_corridor_waypoints',
      ];

      const declaredNames = SCOUT_TOOL_DECLARATIONS.map((t) => t.name);
      expect(declaredNames).toEqual(expectedToolNames);

      for (const tool of SCOUT_TOOL_DECLARATIONS) {
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
        expect(tool.description.length).toBeGreaterThan(10);
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeDefined();
      }

      // Check specific required fields
      const searchWeb = SCOUT_TOOL_DECLARATIONS.find((t) => t.name === 'search_web');
      expect(searchWeb?.inputSchema.required).toEqual(['query']);

      const readUrl = SCOUT_TOOL_DECLARATIONS.find((t) => t.name === 'read_url_content');
      expect(readUrl?.inputSchema.required).toEqual(['url']);

      const resolvePlace = SCOUT_TOOL_DECLARATIONS.find((t) => t.name === 'resolve_and_standardize_place');
      expect(resolvePlace?.inputSchema.required).toEqual(['query']);

      const snap = SCOUT_TOOL_DECLARATIONS.find((t) => t.name === 'snap_to_highway_corridor');
      expect(snap?.inputSchema.required).toEqual(['lat', 'lng']);

      const detour = SCOUT_TOOL_DECLARATIONS.find((t) => t.name === 'calculate_detour_impact');
      expect(detour?.inputSchema.required).toEqual(['candidate_lat', 'candidate_lng', 'after_waypoint_id']);

      const cascade = SCOUT_TOOL_DECLARATIONS.find((t) => t.name === 'simulate_schedule_cascade');
      expect(cascade?.inputSchema.required).toEqual(['action', 'target_waypoint_id']);

      const audit = SCOUT_TOOL_DECLARATIONS.find((t) => t.name === 'audit_corridor_waypoints');
      expect((audit?.inputSchema.properties as Record<string, unknown>)?.day_number).toBeDefined();
    });

    it('cleanPlaceName strips parenthetical qualifiers and slash prefixes', () => {
      // Direct requirement cases:
      expect(cleanPlaceName('Maverik (West Main St)')).toBe('Maverik');
      expect(cleanPlaceName('Flagstaff / Little America Hotel (East)')).toBe('Little America Hotel');
      expect(cleanPlaceName('Valley Park (Picnic / Rest Area)')).toBe('Valley Park');

      // Additional edge cases:
      expect(cleanPlaceName("Love's Travel Stop (Exit 204)")).toBe("Love's Travel Stop");
      expect(cleanPlaceName('Coconino / Sunset Crater (Visitor Center)')).toBe('Sunset Crater');
      expect(cleanPlaceName('Shell')).toBe('Shell');
      expect(cleanPlaceName('   Flying J (I-40)   ')).toBe('Flying J');
      expect(cleanPlaceName('')).toBe('');
      expect(cleanPlaceName(null as unknown as string)).toBe('');
      expect(cleanPlaceName(undefined as unknown as string)).toBe('');
    });
  });

    it('parseScoutResponse deterministically hydrates suggestions with verified Places data', () => {
      const verifiedPlaces: ResolvedPlaceRecord[] = [
        {
          query: 'Maverik Flagstaff',
          place_name: 'Maverik',
          display_name: 'Maverik (West Route 66)',
          address: '1000 W Route 66, Flagstaff, AZ 86001',
          lat: 35.195,
          lng: -111.665,
          google_place_id: 'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q',
        },
        {
          query: 'Scenic Byway Overlook',
          place_name: 'Sedona Overlook',
          display_name: 'Sedona Scenic Overlook',
          address: 'AZ-179, Sedona, AZ',
          lat: 34.81,
          lng: -111.77,
          google_place_id: 'ChIJCR3fWhuQO4cRxCLXXbAfCxQ',
        },
      ];

      const rawAiResponse = `
        I recommend stopping at Maverik for fuel and checking the scenic overlook.
        \`\`\`json:suggestions
        [
          {
            "action": "add_waypoint",
            "name": "Maverik Fuel Stop",
            "type": "fuel",
            "lat": 35.19,
            "lng": -111.66,
            "reason": "Top rated highway fuel."
          },
          {
            "action": "add_waypoint",
            "name": "Sedona Overlook",
            "type": "scenic_drive_by",
            "lat": 34.8005,
            "lng": -111.7667,
            "is_route_anchor": true,
            "reason": "Highway scenic audio alert."
          }
        ]
        \`\`\`
      `;

      const parsed = parseScoutResponse(rawAiResponse, {
        resolvedPlaces: verifiedPlaces,
        knownPlaceIds: new Set(['ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q', 'ChIJCR3fWhuQO4cRxCLXXbAfCxQ']),
      });

      expect(parsed.suggestions).toHaveLength(2);

      // Physical stop (fuel): entrance coordinates hydrated from resolved place
      const fuelSug = parsed.suggestions[0];
      expect(fuelSug.place_name).toBe('Maverik');
      expect(fuelSug.address).toBe('1000 W Route 66, Flagstaff, AZ 86001');
      expect(fuelSug.google_place_id).toBe('ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q');
      expect(fuelSug.lat).toBe(35.195);
      expect(fuelSug.lng).toBe(-111.665);

      // Scenic drive-by with is_route_anchor: true: highway coordinates preserved and kept coordinate-only
      const scenicSug = parsed.suggestions[1];
      expect(scenicSug.name).toBe('Sedona Overlook');
      expect(scenicSug.google_place_id).toBeUndefined();
      expect(scenicSug.address).toBeUndefined();
      expect(scenicSug.lat).toBe(34.8005);
      expect(scenicSug.lng).toBe(-111.7667);
      expect(scenicSug.is_route_anchor).toBe(true);
    });
    it('parseScoutResponse parses delete_waypoint and backfills metadata from tripWaypoints', () => {
      const rawAiResponse = `
        Let's remove the redundant stop.
        \`\`\`json:suggestions
        [
          {
            "action": "delete_waypoint",
            "targetWaypointId": "wp_sedona_lunch",
            "reason": "Replacing lunch with picnic at overlook."
          }
        ]
        \`\`\`
      `;

      const parsed = parseScoutResponse(rawAiResponse, {
        tripWaypoints: sampleTripContext.waypoints,
      });

      expect(parsed.suggestions).toHaveLength(1);
      const delSug = parsed.suggestions[0];
      expect(delSug.action).toBe('delete_waypoint');
      expect(delSug.targetWaypointId).toBe('wp_sedona_lunch');
      expect(delSug.name).toBe('Sedona Cafe'); // Backfilled from sampleTripContext
      expect(delSug.type).toBe('meal');
      expect(delSug.lat).toBe(34.8697);
      expect(delSug.lng).toBe(-111.761);
      expect(delSug.reason).toBe('Replacing lunch with picnic at overlook.');
    });
    it('guarantees per-turn grounding isolation between concurrent chatStream requests', async () => {
      const placeRecordA: ResolvedPlaceRecord = {
        query: 'Stop A',
        place_name: 'Diner Alpha',
        display_name: 'Diner Alpha',
        address: '100 Alpha St',
        lat: 35.1,
        lng: -111.1,
        google_place_id: 'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q',
      };

      const placeRecordB: ResolvedPlaceRecord = {
        query: 'Stop B',
        place_name: 'Diner Beta',
        display_name: 'Diner Beta',
        address: '200 Beta St',
        lat: 34.08,
        lng: -112.08,
        google_place_id: 'ChIJCR3fWhuQO4cRxCLXXbAfCxQ',
      };

      // Mock AI Adapter that invokes the turnDispatcher during generation
      const mockAdapter: AiHarnessAdapter = {
        id: 'bedrock',
        name: 'Amazon Bedrock',
        isAvailable: vi.fn().mockResolvedValue(true),
        getAvailableModels: vi.fn().mockResolvedValue([]),
        getModelCatalog: vi.fn().mockReturnValue({
          models: [{ id: 'us.moonshotai.kimi-k3', name: 'Kimi K3', role: 'both', provider: 'Moonshot AI' }],
          defaultScoutModelId: 'us.moonshotai.kimi-k3',
          defaultCopywriterModelId: 'us.amazon.nova-2-lite-v1:0',
        }),
        validateModelId: vi.fn().mockResolvedValue('us.moonshotai.kimi-k3'),
        decorateScoutPrompt: (p: string) => p,
        sanitizeResponse: (t: string) => t,
        generate: vi.fn(),
        generateStreamWithTools: vi.fn(async (prompt, _tools, dispatcher) => {
          if (prompt.includes('Request A')) {
            // Request A resolves Diner Alpha
            await dispatcher?.('resolve_and_standardize_place', { query: 'Diner Alpha' });
            return {
              text: 'Here is stop A:\n```json:suggestions\n[{"action":"add_waypoint","name":"Diner Alpha","type":"meal","lat":35.0,"lng":-111.0}]\n```',
              inputTokens: 10,
              outputTokens: 20,
            };
          } else {
            // Request B resolves Diner Beta
            await dispatcher?.('resolve_and_standardize_place', { query: 'Diner Beta' });
            return {
              text: 'Here is stop B:\n```json:suggestions\n[{"action":"add_waypoint","name":"Diner Beta","type":"meal","lat":34.0,"lng":-112.0}]\n```',
              inputTokens: 10,
              outputTokens: 20,
            };
          }
        }),
      };

      const customDispatcher = vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === 'resolve_and_standardize_place') {
          const q = args.query as string;
          if (q.includes('Alpha')) {
            return { query: q, places: [placeRecordA], best_match: placeRecordA };
          } else {
            return { query: q, places: [placeRecordB], best_match: placeRecordB };
          }
        }
        return {};
      });

      const aiService = new AiService({ adapters: [mockAdapter], primaryAdapterId: 'bedrock' });
      const scoutService = new ScoutService({
        aiService,
        toolDispatcher: customDispatcher,
      });

      const reqA: ScoutChatRequest = {
        scope: { type: 'day', dayNumber: 1 },
        messages: [{ role: 'user', content: 'Request A for lunch' }],
        tripContext: sampleTripContext,
      };

      const reqB: ScoutChatRequest = {
        scope: { type: 'day', dayNumber: 1 },
        messages: [{ role: 'user', content: 'Request B for lunch' }],
        tripContext: sampleTripContext,
      };

      // Run concurrently
      const [resA, resB] = await Promise.all([
        scoutService.chatStream(reqA, () => {}),
        scoutService.chatStream(reqB, () => {}),
      ]);

      // Turn A suggestions are strictly hydrated from placeRecordA
      expect(resA.suggestions[0].place_name).toBe('Diner Alpha');
      expect(resA.suggestions[0].address).toBe('100 Alpha St');
      expect(resA.suggestions[0].google_place_id).toBe('ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q');

      // Turn B suggestions are strictly hydrated from placeRecordB
      expect(resB.suggestions[0].place_name).toBe('Diner Beta');
      expect(resB.suggestions[0].address).toBe('200 Beta St');
      expect(resB.suggestions[0].google_place_id).toBe('ChIJCR3fWhuQO4cRxCLXXbAfCxQ');
    });
    it('formatBedrockToolLabel formats active and done labels for all Route Scout tools', () => {
      // 1. search_web
      expect(formatBedrockToolLabel('search_web', { query: 'Sedona cafes' }, false)).toBe(
        'Searching web: "Sedona cafes"'
      );
      expect(formatBedrockToolLabel('search_web', { query: 'Sedona cafes' }, true)).toBe(
        'Searched web for "Sedona cafes"'
      );

      // 2. read_url_content
      expect(formatBedrockToolLabel('read_url_content', { url: 'https://example.com/guide' }, false)).toBe(
        'Reading content from example.com'
      );
      expect(formatBedrockToolLabel('read_url_content', { url: 'https://example.com/guide' }, true)).toBe(
        'Read content from example.com'
      );
      expect(formatBedrockToolLabel('read_url_content', {}, false)).toBe('Reading web content...');
      expect(formatBedrockToolLabel('read_url_content', {}, true)).toBe('Completed reading web content');

      // 3. resolve_and_standardize_place
      expect(formatBedrockToolLabel('resolve_and_standardize_place', { query: 'Maverik' }, false)).toBe(
        'Verifying place: "Maverik"'
      );
      expect(formatBedrockToolLabel('resolve_and_standardize_place', { query: 'Maverik' }, true)).toBe(
        'Verified place "Maverik"'
      );
      expect(formatBedrockToolLabel('resolve_and_standardize_place', {}, false)).toBe(
        'Verifying place details...'
      );
      expect(formatBedrockToolLabel('resolve_and_standardize_place', {}, true)).toBe(
        'Verified place details'
      );

      // 4. snap_to_highway_corridor
      expect(formatBedrockToolLabel('snap_to_highway_corridor', { road_name: 'US-89' }, false)).toBe(
        'Snapping coordinate to US-89...'
      );
      expect(formatBedrockToolLabel('snap_to_highway_corridor', { road_name: 'US-89' }, true)).toBe(
        'Snapped coordinate to US-89'
      );

      // 5. calculate_detour_impact
      expect(formatBedrockToolLabel('calculate_detour_impact', {}, false)).toBe(
        'Calculating detour driving impact...'
      );
      expect(formatBedrockToolLabel('calculate_detour_impact', {}, true)).toBe(
        'Calculated detour driving impact'
      );

      // 6. simulate_schedule_cascade
      expect(formatBedrockToolLabel('simulate_schedule_cascade', {}, false)).toBe(
        'Simulating schedule cascade...'
      );
      expect(formatBedrockToolLabel('simulate_schedule_cascade', {}, true)).toBe(
        'Simulated schedule cascade'
      );

      // 7. audit_corridor_waypoints
      expect(formatBedrockToolLabel('audit_corridor_waypoints', {}, false)).toBe(
        'Auditing corridor waypoints...'
      );
      expect(formatBedrockToolLabel('audit_corridor_waypoints', {}, true)).toBe(
        'Audited corridor waypoints'
      );

      // Fallback
      expect(formatBedrockToolLabel('custom_unknown_tool', {}, false)).toBe('Running custom unknown tool...');
      expect(formatBedrockToolLabel('custom_unknown_tool', {}, true)).toBe('Completed custom unknown tool');
    });
    it('hydrateSuggestionFromResolvedPlaces does not overwrite scenic_pull_off coordinates or cross-pollinate mismatched Place IDs', () => {
      const places: ResolvedPlaceRecord[] = [
        {
          query: 'Coffee Shop',
          place_name: 'Rim View Coffee',
          display_name: 'Rim View Coffee',
          address: '100 Rim Dr',
          lat: 34.8001,
          lng: -111.7661,
          google_place_id: 'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q',
        },
      ];

      // 1. A scenic_pull_off 0.05 miles away from a coffee shop must NOT be proximity-matched or moved (F-31)
      const scenicPullOff = hydrateSuggestionFromResolvedPlaces(
        {
          id: 'sug_1',
          action: 'add_waypoint',
          name: 'Canyon Rim Overlook',
          type: 'scenic_pull_off',
          lat: 34.8005,
          lng: -111.7665,
          dwell_minutes: 15,
          reason: 'Scenic canyon vista.',
        },
        places,
        new Set(['ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q'])
      );
      expect(scenicPullOff.lat).toBe(34.8005);
      expect(scenicPullOff.lng).toBe(-111.7665);
      expect(scenicPullOff.google_place_id).toBeUndefined();

      // 2. A suggestion with an explicit Place ID must NOT be matched by name/proximity to a different Place ID (F-32)
      const explicitPlaceSug = hydrateSuggestionFromResolvedPlaces(
        {
          id: 'sug_2',
          action: 'add_waypoint',
          name: 'Rim View Coffee',
          type: 'meal',
          lat: 34.8002,
          lng: -111.7662,
          google_place_id: 'ChIJCR3fWhuQO4cRxCLXXbAfCxQ',
          reason: 'Different branch.',
        },
        places,
        new Set(['ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q', 'ChIJCR3fWhuQO4cRxCLXXbAfCxQ'])
      );
      expect(explicitPlaceSug.google_place_id).toBe('ChIJCR3fWhuQO4cRxCLXXbAfCxQ');
      expect(explicitPlaceSug.lat).toBe(34.8002);
      expect(explicitPlaceSug.address).toBeUndefined();
    });
    it('parseScoutResponse drops delete_waypoint with unknown ID and overrides spoofed name/type from tripWaypoints', () => {
      const rawOutput = `
        Removing stop.
        \`\`\`json:suggestions
        [
          {
            "action": "delete_waypoint",
            "targetWaypointId": "non_existent_id",
            "name": "Hallucinated Stop",
            "reason": "Does not exist."
          },
          {
            "action": "delete_waypoint",
            "targetWaypointId": "wp_sedona_lunch",
            "name": "Spoofed Harmless Stop Name",
            "type": "scenic_drive_by",
            "lat": 0,
            "lng": 0,
            "reason": "Actually deleting Sedona Cafe."
          }
        ]
        \`\`\`
      `;

      const parsed = parseScoutResponse(rawOutput, {
        tripWaypoints: sampleTripContext.waypoints,
      });

      // Unknown ID dropped; spoofed card uses true name/type/lat/lng from sampleTripContext.waypoints (F-34)
      expect(parsed.suggestions).toHaveLength(1);
      expect(parsed.suggestions[0].targetWaypointId).toBe('wp_sedona_lunch');
      expect(parsed.suggestions[0].name).toBe('Sedona Cafe');
      expect(parsed.suggestions[0].type).toBe('meal');
      expect(parsed.suggestions[0].lat).toBe(34.8697);
      expect(parsed.suggestions[0].lng).toBe(-111.761);
    });
    it('keeps scenic navigation anchors coordinate-only end-to-end from hydration through Google Maps URL generation while preserving positional Place ID alignment', () => {
      const resolvedPlaces: ResolvedPlaceRecord[] = [
        {
          query: 'Oak Creek Vista',
          place_name: 'Oak Creek Vista Overlook',
          display_name: 'Oak Creek Vista',
          address: 'US-89A, Sedona, AZ 86336',
          lat: 35.0225,
          lng: -111.7375,
          google_place_id: 'ChIJCR3fWhuQO4cRxCLXXbAfCxQ',
        },
        {
          query: 'Flagstaff Diner',
          place_name: 'Galaxy Diner',
          display_name: 'Galaxy Diner',
          address: '931 W Route 66, Flagstaff, AZ 86001',
          lat: 35.1955,
          lng: -111.6625,
          google_place_id: 'ChIJ2wW_a80KK4cR24D7xO_z5Y4',
        },
      ];
      const knownIds = new Set([
        'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q',
        'ChIJCR3fWhuQO4cRxCLXXbAfCxQ',
        'ChIJ2wW_a80KK4cR24D7xO_z5Y4',
      ]);

      const rawOutput = `Here are your scenic anchor and diner updates:
\`\`\`json:suggestions
[
  {
    "action": "add_waypoint",
    "afterWaypointId": "wp_sedona_lunch",
    "name": "Oak Creek Vista Overlook",
    "place_name": "Oak Creek Vista Overlook",
    "type": "scenic_drive_by",
    "lat": 35.0221,
    "lng": -111.7371,
    "dwell_minutes": 0,
    "google_place_id": "ChIJCR3fWhuQO4cRxCLXXbAfCxQ",
    "is_route_anchor": true,
    "reason": "Keep route on US-89A switchbacks."
  },
  {
    "action": "add_waypoint",
    "afterWaypointId": "wp_sedona_lunch",
    "name": "Galaxy Diner",
    "place_name": "Galaxy Diner",
    "type": "meal",
    "lat": 35.195,
    "lng": -111.662,
    "dwell_minutes": 45,
    "reason": "Retro Route 66 dinner."
  }
]
\`\`\``;

      const parsed = parseScoutResponse(rawOutput, {
        resolvedPlaces,
        knownPlaceIds: knownIds,
        tripWaypoints: sampleTripContext.waypoints,
      });

      expect(parsed.suggestions).toHaveLength(2);
      const scenicAnchorSug = parsed.suggestions[0];
      const physicalDinerSug = parsed.suggestions[1];

      // Scenic anchor stripped of google_place_id and kept at exact highway coordinates
      expect(isInTransitOrAnchorSuggestion(scenicAnchorSug)).toBe(true);
      expect(scenicAnchorSug.google_place_id).toBeUndefined();
      expect(scenicAnchorSug.address).toBeUndefined();
      expect(scenicAnchorSug.lat).toBe(35.0221);
      expect(scenicAnchorSug.lng).toBe(-111.7371);

      // Physical stop retains verified Place ID, address, and entrance coordinates
      expect(isInTransitOrAnchorSuggestion(physicalDinerSug)).toBe(false);
      expect(physicalDinerSug.google_place_id).toBe('ChIJ2wW_a80KK4cR24D7xO_z5Y4');
      expect(physicalDinerSug.address).toBe('931 W Route 66, Flagstaff, AZ 86001');
      expect(physicalDinerSug.lat).toBe(35.1955);
      expect(physicalDinerSug.lng).toBe(-111.6625);

    });
});
