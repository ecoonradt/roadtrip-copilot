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

describe('Route Scout corridor, detour, and schedule grounding', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
  });

  describe('5. Domain Grounding Tools', () => {
    describe('snap_to_highway_corridor', () => {
      it('preserves literal comma in OSRM URL and matches road name against candidates', async () => {
        let requestedUrl = '';
        const mockFetch: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
          requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          return new Response(
            JSON.stringify({
              code: 'Ok',
              waypoints: [
                {
                  name: 'Frontage Road',
                  location: [-111.767, 34.801],
                  distance: 12,
                },
                {
                  name: 'US Highway 89',
                  location: [-111.7667, 34.8005],
                  distance: 25,
                },
              ],
            }),
            { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }
          );
        });

        const toolLib = new ScoutToolLibrary({ fetchImpl: mockFetch });
        const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

        const result = await toolLib.snapToHighwayCorridor(
          { lat: 34.8005, lng: -111.7667, road_name: 'US-89' },
          context
        );

        // Verify URL contains literal unencoded comma
        expect(requestedUrl).toContain('/-111.7667,34.8005?number=5');
        expect(requestedUrl).not.toContain('%2C');
        expect(requestedUrl).not.toContain('%2c');

        // Verify highway token matching ("US-89" matches "US Highway 89")
        expect(result.road_name_matched).toBe(true);
        expect(result.snapped_road_name).toBe('US Highway 89');
        expect(result.snapped_lat).toBe(34.8005);
        expect(result.snapped_lng).toBe(-111.7667);
      });

      it('falls back to closest candidate with road_name_matched: false when unmatched', async () => {
        const mockFetch: typeof fetch = vi.fn(async () => {
          return new Response(
            JSON.stringify({
              code: 'Ok',
              waypoints: [
                {
                  name: 'AZ-179',
                  location: [-111.7667, 34.8005],
                  distance: 5,
                },
              ],
            }),
            { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }
          );
        });

        const toolLib = new ScoutToolLibrary({ fetchImpl: mockFetch });
        const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

        const result = await toolLib.snapToHighwayCorridor(
          { lat: 34.8005, lng: -111.7667, road_name: 'I-10' },
          context
        );

        expect(result.road_name_matched).toBe(false);
        expect(result.snapped_road_name).toBe('AZ-179');
      });

      it('fails loudly when OSRM returns HTTP 500 or non-Ok status', async () => {
        const mockFetch: typeof fetch = vi.fn(async () => {
          return new Response('Server Error', { status: 500 });
        });

        const toolLib = new ScoutToolLibrary({ fetchImpl: mockFetch });
        const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

        await expect(
          toolLib.snapToHighwayCorridor({ lat: 34.8005, lng: -111.7667 }, context)
        ).rejects.toThrow('OSRM nearest failed with HTTP 500');
      });
    });

    describe('calculate_detour_impact', () => {
      it('runs baseline and detour routes in parallel and calculates added miles and minutes', async () => {
        const routeCalls: string[] = [];
        const mockRouteService = {
          getRoute: vi.fn(async (coords: string) => {
            routeCalls.push(coords);
            const pairs = coords.split(';');
            if (pairs.length === 2) {
              // Baseline leg (Bell Rock -> Sedona Cafe): 5.0 mi, 8.0 min
              return { distanceMiles: 5.0, durationMinutes: 8.0 };
            } else {
              // Detour leg (Bell Rock -> Red Rock Overlook -> Sedona Cafe): 8.5 mi, 14.5 min
              return { distanceMiles: 8.5, durationMinutes: 14.5 };
            }
          }),
        } as unknown as RouteService;

        const toolLib = new ScoutToolLibrary({ routeService: mockRouteService });
        const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

        const res = await toolLib.calculateDetourImpact(
          {
            candidate_lat: 34.82,
            candidate_lng: -111.78,
            after_waypoint_id: 'wp_bell_rock',
          },
          context
        );

        expect(routeCalls).toHaveLength(2);
        expect(res.baseline_leg_miles).toBe(5.0);
        expect(res.baseline_leg_minutes).toBe(8.0);
        expect(res.detour_leg_miles).toBe(8.5);
        expect(res.detour_leg_minutes).toBe(14.5);
        expect(res.added_distance_miles).toBe(3.5);
        expect(res.added_duration_minutes).toBe(6.5);
      });

      it('handles appending candidate after the final stop', async () => {
        const mockRouteService = {
          getRoute: vi.fn(async () => {
            return { distanceMiles: 12.0, durationMinutes: 18.0 };
          }),
        } as unknown as RouteService;

        const toolLib = new ScoutToolLibrary({ routeService: mockRouteService });
        const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

        const res = await toolLib.calculateDetourImpact(
          {
            candidate_lat: 35.3,
            candidate_lng: -111.6,
            after_waypoint_id: 'wp_dest', // Final stop in sampleTripContext
          },
          context
        );

        expect(res.baseline_leg_miles).toBe(0);
        expect(res.baseline_leg_minutes).toBe(0);
        expect(res.added_distance_miles).toBe(12.0);
        expect(res.added_duration_minutes).toBe(18.0);
      });

      it('throws descriptive error listing available waypoint IDs when after_waypoint_id is unknown', async () => {
        const toolLib = new ScoutToolLibrary();
        const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

        await expect(
          toolLib.calculateDetourImpact(
            { candidate_lat: 34.0, candidate_lng: -111.0, after_waypoint_id: 'wp_nonexistent' },
            context
          )
        ).rejects.toThrow(
          'Waypoint "wp_nonexistent" not found in active trip context. Available IDs: wp_origin, wp_bell_rock, wp_sedona_lunch, wp_dest'
        );
      });
    });

    describe('simulate_schedule_cascade', () => {
      it('simulates forward schedule cascade for action "add"', async () => {
        const mockRouteService = {
          getRoute: vi.fn().mockResolvedValue({
            distanceMiles: 4.5,
            durationMinutes: 8,
            durationSeconds: 480,
            geometry: { type: 'LineString', coordinates: [] },
          }),
        } as unknown as RouteService;
        const toolLib = new ScoutToolLibrary({ routeService: mockRouteService });
        const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

        const res = await toolLib.simulateScheduleCascade(
          {
            action: 'add',
            target_waypoint_id: 'wp_bell_rock',
            candidate_name: 'Chapel of the Holy Cross',
            candidate_type: 'scenic_pull_off',
            candidate_lat: 34.832,
            candidate_lng: -111.766,
            dwell_minutes: 25,
          },
          context
        );

        expect(res.action).toBe('add');
        expect(res.target_waypoint_id).toBe('wp_bell_rock');
        expect(res.stops).toHaveLength(5); // 4 original + 1 added
        const added = res.stops.find((s) => s.name === 'Chapel of the Holy Cross');
        expect(added).toBeDefined();
        expect(added?.dwell_minutes).toBe(25);
        expect(res.total_dwell_minutes).toBe(70); // 45 (lunch) + 25 (added)
        expect(mockRouteService.getRoute).toHaveBeenCalledTimes(2);
      });

      it('simulates action "update" preserving untouched leg drive durations', async () => {
        const mockRouteService = {
          getRoute: vi.fn(),
        } as unknown as RouteService;
        const toolLib = new ScoutToolLibrary({ routeService: mockRouteService });
        const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

        // Updating Sedona Lunch dwell from 45m to 60m
        const res = await toolLib.simulateScheduleCascade(
          {
            action: 'update',
            target_waypoint_id: 'wp_sedona_lunch',
            dwell_minutes: 60,
          },
          context
        );

        expect(res.action).toBe('update');
        const lunchStop = res.stops.find((s) => s.id === 'wp_sedona_lunch');
        expect(lunchStop?.dwell_minutes).toBe(60);

        // Untouched leg duration from bell rock to lunch was preserved without calling RouteService
        expect(lunchStop?.drive_minutes_from_previous).toBe(10);
        expect(mockRouteService.getRoute).not.toHaveBeenCalled();
      });

      it('simulates action "delete" removing the target waypoint', async () => {
        const mockRouteService = {
          getRoute: vi.fn().mockResolvedValue({
            distanceMiles: 35.0,
            durationMinutes: 55,
            durationSeconds: 3300,
            geometry: { type: 'LineString', coordinates: [] },
          }),
        } as unknown as RouteService;
        const toolLib = new ScoutToolLibrary({ routeService: mockRouteService });
        const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

        const res = await toolLib.simulateScheduleCascade(
          {
            action: 'delete',
            target_waypoint_id: 'wp_sedona_lunch',
          },
          context
        );

        expect(res.action).toBe('delete');
        expect(res.stops).toHaveLength(3);
        expect(res.stops.some((s) => s.id === 'wp_sedona_lunch')).toBe(false);
        expect(mockRouteService.getRoute).toHaveBeenCalledTimes(1);
      });

      it('generates sunset warnings when stops arrive at or after 18:30 local time', async () => {
        const lateTripContext: ScoutTripContext = {
          ...sampleTripContext,
          departureTime: '17:00:00', // Departing at 5 PM, so later stops arrive after 18:30
        };

        const toolLib = new ScoutToolLibrary();
        const context: ScoutToolExecutionContext = { tripContext: lateTripContext };

        const res = await toolLib.simulateScheduleCascade(
          {
            action: 'update',
            target_waypoint_id: 'wp_bell_rock',
            dwell_minutes: 0,
          },
          context
        );

        expect(res.sunset_warnings.length).toBeGreaterThan(0);
        for (const warn of res.sunset_warnings) {
          const [h, m] = warn.arrival_time.split(':').map((n) => parseInt(n, 10));
          expect(h > 18 || (h === 18 && m >= 30)).toBe(true);
        }
      });
    });

    describe('audit_corridor_waypoints', () => {
      it('flags all structural and corridor anomalies concurrently', async () => {
        const mockFetch: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
          const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          // Return > 75m for the drive-by point to trigger off_highway_drive_by
          if (urlStr.includes('-111.7667,34.8005')) {
            return new Response(
              JSON.stringify({
                code: 'Ok',
                waypoints: [{ name: 'Service Track', location: [-111.7667, 34.8005], distance: 150 }],
              }),
              { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }
            );
          }
          return new Response(
            JSON.stringify({
              code: 'Ok',
              waypoints: [{ name: 'AZ-179', location: [-111.761, 34.8697], distance: 10 }],
            }),
            { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }
          );
        });

        const problematicWaypoints = [
          // 1. Off-highway drive-by (> 75m)
          {
            id: 'wp_driveby_off',
            name: 'Scenic Overlook',
            type: 'scenic_drive_by',
            lat: 34.8005,
            lng: -111.7667,
            dwell_minutes: 0,
          },
          // 2. Low leg speed anomaly (< 30 mph over >= 2 miles)
          {
            id: 'wp_slow_dirt',
            name: 'Canyon Viewpoint',
            type: 'scenic_pull_off',
            lat: 34.85,
            lng: -111.75,
            drive_distance_miles: 4.5,
            drive_speed_mph: 18,
          },
          // 3. Invalid Google Place ID
          {
            id: 'wp_fake_id',
            name: 'Local Diner',
            type: 'meal',
            lat: 34.86,
            lng: -111.76,
            google_place_id: 'ChIJ_not_protobuf_valid',
            address: '123 Main St',
            place_name: 'Local Diner',
          },
          // 4. Missing physical stop metadata
          {
            id: 'wp_missing_meta',
            name: 'Fuel Oasis',
            type: 'fuel',
            lat: 34.87,
            lng: -111.77,
            // missing address and place_name
          },
          // 5. Invalid route anchor on physical stop
          {
            id: 'wp_physical_anchor',
            name: 'Sedona Resort',
            type: 'lodging',
            lat: 34.88,
            lng: -111.78,
            address: '500 Resort Way',
            place_name: 'Sedona Resort',
            is_route_anchor: true, // Forbidden on physical stops
          },
          // 6. Non-anticipatory speech
          {
            id: 'wp_past_speech',
            name: 'Highway Transition',
            type: 'scenic_drive_by',
            lat: 34.89,
            lng: -111.79,
            notification: {
              title: 'Canyon View',
              message: 'Canyon view ahead.',
              speech: 'Now cruising along the red rock cliffs on your right.',
            },
          },
          // 7. Category notification mismatch
          {
            id: 'wp_fuel_stop_meal_type',
            name: 'Gas & Convenience',
            type: 'meal', // Type is meal but id refers to fuel
            lat: 34.9,
            lng: -111.8,
            address: '777 Hwy 89',
            place_name: 'Gas Stop',
          },
        ];

        const auditContext: ScoutToolExecutionContext = {
          tripContext: {
            ...sampleTripContext,
            waypoints: problematicWaypoints,
          },
        };

        const toolLib = new ScoutToolLibrary({ fetchImpl: mockFetch });
        const res = await toolLib.auditCorridorWaypoints({}, auditContext);

        expect(res.flagged_count).toBe(7);

        const issues1 = res.waypoints.find((w) => w.id === 'wp_driveby_off')?.issues;
        expect(issues1?.some((i) => i.includes('off_highway_drive_by'))).toBe(true);

        const issues2 = res.waypoints.find((w) => w.id === 'wp_slow_dirt')?.issues;
        expect(issues2?.some((i) => i.includes('low_leg_speed_anomaly'))).toBe(true);

        const issues3 = res.waypoints.find((w) => w.id === 'wp_fake_id')?.issues;
        expect(issues3?.some((i) => i.includes('invalid_google_place_id'))).toBe(true);

        const issues4 = res.waypoints.find((w) => w.id === 'wp_missing_meta')?.issues;
        expect(issues4?.some((i) => i.includes('missing_physical_stop_metadata'))).toBe(true);

        const issues5 = res.waypoints.find((w) => w.id === 'wp_physical_anchor')?.issues;
        expect(issues5?.some((i) => i.includes('invalid_route_anchor_on_physical_stop'))).toBe(true);

        const issues6 = res.waypoints.find((w) => w.id === 'wp_past_speech')?.issues;
        expect(issues6?.some((i) => i.includes('non_anticipatory_speech'))).toBe(true);

        const issues7 = res.waypoints.find((w) => w.id === 'wp_fuel_stop_meal_type')?.issues;
        expect(issues7?.some((i) => i.includes('category_notification_mismatch'))).toBe(true);
      });

      it('fails loudly when OSRM nearest returns HTTP 500 during audit', async () => {
        const mockFetch: typeof fetch = vi.fn(async () => {
          return new Response('OSRM Error', { status: 500 });
        });

        const toolLib = new ScoutToolLibrary({ fetchImpl: mockFetch });
        const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

        await expect(
          toolLib.auditCorridorWaypoints({}, context)
        ).rejects.toThrow('OSRM nearest failed with HTTP 500');
      });
    });
  });

    it('snap_to_highway_corridor distinguishes US-89 from I-89 and State Route 89', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'Ok',
            waypoints: [
              { name: 'Interstate 89', distance: 10, location: [-111.65, 35.2] },
              { name: 'US Highway 89', distance: 25, location: [-111.66, 35.21] },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

      const toolLib = new ScoutToolLibrary({ fetchImpl: mockFetch });
      const res = await toolLib.snapToHighwayCorridor(
        { lat: 35.2, lng: -111.65, road_name: 'US-89' },
        { tripContext: sampleTripContext }
      );

      expect(res.road_name_matched).toBe(true);
      expect(res.snapped_road_name).toBe('US Highway 89');
      expect(res.snapped_lat).toBe(35.21);
    });
    it('audit_corridor_waypoints does not false-positive match "gas" inside "Las Vegas"', async () => {
      const mockFetch = vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              code: 'Ok',
              waypoints: [{ name: 'I-15', distance: 5, location: [-115.1398, 36.1699] }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      );

      const toolLib = new ScoutToolLibrary({ fetchImpl: mockFetch });
      const vegasContext: ScoutTripContext = {
        tripName: 'Vegas Trip',
        waypoints: [
          {
            id: 'wp_vegas_lunch',
            name: 'Las Vegas Bistro',
            place_name: 'Las Vegas Bistro',
            address: '100 Las Vegas Blvd, Las Vegas, NV',
            type: 'meal',
            lat: 36.1699,
            lng: -115.1398,
            dwell_minutes: 45,
            notification: {
              title: 'Las Vegas Lunch',
              message: 'Stopping in Las Vegas for lunch.',
              speech: 'Approaching Las Vegas Bistro ahead in half a mile.',
            },
          },
          {
            id: 'wp_vegas_hotel',
            name: 'Las Vegas Resort',
            type: 'destination',
            lat: 36.1701,
            lng: -115.1399,
            dwell_minutes: 0,
          },
        ],
      };

      const res = await toolLib.auditCorridorWaypoints({}, { tripContext: vegasContext });
      expect(res.flagged_count).toBe(0);
    });
    it('routes changed schedule legs via RouteService instead of 50 mph Haversine estimation, preserves unchanged legs, handles timezones, and fails loudly on routing errors', async () => {
      // North Rim -> South Rim Grand Canyon example (11.68 mi straight-line vs 210.4 mi road route)
      const canyonTripContext: ScoutTripContext = {
        tripName: 'Grand Canyon Rim-to-Rim Drive',
        date: '2026-10-10',
        origin: 'North Rim, AZ',
        destination: 'Flagstaff, AZ',
        departureTime: '08:00:00',
        waypoints: [
          {
            id: 'wp_north_rim',
            name: 'Grand Canyon North Rim Lodge',
            type: 'origin',
            lat: 36.198,
            lng: -112.052,
            dwell_minutes: 0,
            timezone: 'America/Phoenix',
          },
          {
            id: 'wp_jacob_lake',
            name: 'Jacob Lake Inn',
            type: 'meal',
            lat: 36.713,
            lng: -112.216,
            dwell_minutes: 30,
            drive_distance_miles: 44.0,
            drive_duration_minutes: 55,
            timezone: 'America/Phoenix',
          },
          {
            id: 'wp_south_rim',
            name: 'South Rim Visitor Center',
            type: 'scenic_pull_off',
            lat: 36.054,
            lng: -112.14,
            dwell_minutes: 60,
            drive_distance_miles: 166.4,
            drive_duration_minutes: 240,
            timezone: 'America/Phoenix',
          },
          {
            id: 'wp_bluff_ut',
            name: 'Bluff Desert Inn',
            type: 'destination',
            lat: 37.284,
            lng: -109.552,
            dwell_minutes: 0,
            drive_distance_miles: 190.0,
            drive_duration_minutes: 210,
            timezone: 'America/Denver',
          },
        ],
      };

      const getRouteMock = vi.fn().mockResolvedValue({
        distanceMiles: 210.4,
        durationMinutes: 295,
        durationSeconds: 17700,
        geometry: { type: 'LineString', coordinates: [] },
      });
      const mockRouteService = { getRoute: getRouteMock } as unknown as RouteService;
      const toolLib = new ScoutToolLibrary({ routeService: mockRouteService });

      const originalSnapshot = JSON.stringify(canyonTripContext.waypoints);

      // 5A. Deleting Jacob Lake bridges North Rim -> South Rim via RouteService (210.4 mi / 295 min, NOT 11.68 mi / 14 min!)
      // while preserving South Rim -> Bluff UT (190.0 mi / 210 min) without re-routing it.
      const delRes = await toolLib.simulateScheduleCascade(
        { action: 'delete', target_waypoint_id: 'wp_jacob_lake' },
        { tripContext: canyonTripContext }
      );

      expect(getRouteMock).toHaveBeenCalledTimes(1);
      expect(getRouteMock).toHaveBeenCalledWith('-112.052,36.198;-112.14,36.054', undefined, undefined);
      expect(delRes.stops).toHaveLength(3);
      expect(delRes.stops[1].id).toBe('wp_south_rim');
      expect(delRes.stops[1].distance_miles_from_previous).toBe(210.4);
      expect(delRes.stops[1].drive_minutes_from_previous).toBe(295);
      // Unchanged leg preserved
      expect(delRes.stops[2].id).toBe('wp_bluff_ut');
      expect(delRes.stops[2].distance_miles_from_previous).toBe(190.0);
      expect(delRes.stops[2].drive_minutes_from_previous).toBe(210);
      // Timezone crossing preserved (America/Phoenix UTC-7 -> America/Denver UTC-6 MDT)
      expect(delRes.timezones_crossed).toEqual(['America/Phoenix', 'America/Denver']);
      // Input waypoints not mutated
      expect(JSON.stringify(canyonTripContext.waypoints)).toBe(originalSnapshot);

      // 5B. Coordinate relocation on update routes both affected legs
      getRouteMock.mockClear();
      getRouteMock
        .mockResolvedValueOnce({
          distanceMiles: 50.0,
          durationMinutes: 60,
          durationSeconds: 3600,
          geometry: { type: 'LineString', coordinates: [] },
        })
        .mockResolvedValueOnce({
          distanceMiles: 160.0,
          durationMinutes: 230,
          durationSeconds: 13800,
          geometry: { type: 'LineString', coordinates: [] },
        });

      const relocRes = await toolLib.simulateScheduleCascade(
        {
          action: 'update',
          target_waypoint_id: 'wp_jacob_lake',
          candidate_lat: 36.85,
          candidate_lng: -112.15,
          dwell_minutes: 0,
        },
        { tripContext: canyonTripContext }
      );
      expect(getRouteMock).toHaveBeenCalledTimes(2);
      expect(relocRes.stops[1].distance_miles_from_previous).toBe(50.0);
      expect(relocRes.stops[1].dwell_minutes).toBe(0);
      expect(relocRes.stops[2].distance_miles_from_previous).toBe(160.0);

      // 5C. Dwell-only update with dwell_minutes: 0 makes zero RouteService calls
      getRouteMock.mockClear();
      const dwellZeroRes = await toolLib.simulateScheduleCascade(
        {
          action: 'update',
          target_waypoint_id: 'wp_jacob_lake',
          dwell_minutes: 0,
        },
        { tripContext: canyonTripContext }
      );
      expect(getRouteMock).not.toHaveBeenCalled();
      expect(dwellZeroRes.stops[1].dwell_minutes).toBe(0);

      // 5D. Upstream RouteService failure propagates loudly without silent fallback
      const failingRouteService = {
        getRoute: vi.fn().mockRejectedValue(new Error('OSRM upstream routing service unavailable (502)')),
      } as unknown as RouteService;
      const failingToolLib = new ScoutToolLibrary({ routeService: failingRouteService });
      await expect(
        failingToolLib.simulateScheduleCascade(
          { action: 'delete', target_waypoint_id: 'wp_jacob_lake' },
          { tripContext: canyonTripContext }
        )
      ).rejects.toThrow('OSRM upstream routing service unavailable (502)');
    });
    it('matches complete highway designators strictly without substring cross-matching (I-40 vs I-405, US-89 vs US-89A, I-89 vs US-89 vs AZ-89)', async () => {
      // Unit assertions on parseHighwayDesignators and matchesHighwayRoadName
      expect(parseHighwayDesignators('I-405 North')).toEqual([{ kind: 'interstate', number: '405' }]);
      expect(parseHighwayDesignators('Interstate 40')).toEqual([{ kind: 'interstate', number: '40' }]);
      expect(parseHighwayDesignators('U.S. Highway 89A')).toEqual([{ kind: 'us', number: '89a' }]);
      expect(parseHighwayDesignators('AZ-179 / State Route 179')).toEqual([
        { kind: 'state', number: '179' },
        { kind: 'state', stateCode: 'az', number: '179' },
      ]);

      // Different numbers: I-40 must NEVER match I-405
      expect(matchesHighwayRoadName('I-405', 'I-40')).toBe(false);
      expect(matchesHighwayRoadName('Interstate 405', 'I-40')).toBe(false);
      expect(matchesHighwayRoadName('Interstate 40', 'I-40')).toBe(true);
      expect(matchesHighwayRoadName('IH-40', 'I-40')).toBe(true);

      // Suffixes: US-89 must NEVER match US-89A
      expect(matchesHighwayRoadName('US-89A', 'US-89')).toBe(false);
      expect(matchesHighwayRoadName('US-89', 'US-89A')).toBe(false);
      expect(matchesHighwayRoadName('U.S. Highway 89A', 'US-89A')).toBe(true);

      // Network & state distinctions: I-89 vs US-89 vs AZ-89 vs UT-89
      expect(matchesHighwayRoadName('I-89', 'US-89')).toBe(false);
      expect(matchesHighwayRoadName('AZ-89', 'US-89')).toBe(false);
      expect(matchesHighwayRoadName('AZ-89', 'UT-89')).toBe(false);
      expect(matchesHighwayRoadName('State Route 89', 'AZ-89')).toBe(true);
      expect(matchesHighwayRoadName('SR 179', 'AZ-179')).toBe(true);

      // End-to-end snapToHighwayCorridor: skips closer I-405 candidate to select true I-40 match
      const mockOsrmFetch: typeof fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            code: 'Ok',
            waypoints: [
              { name: 'I-405', location: [-111.76, 35.19], distance: 5 },
              { name: 'Interstate 40', location: [-111.75, 35.2], distance: 18 },
            ],
          }),
          { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }
        );
      });

      const toolLib = new ScoutToolLibrary({ fetchImpl: mockOsrmFetch });
      const matchedRes = await toolLib.snapToHighwayCorridor(
        { lat: 35.195, lng: -111.755, road_name: 'I-40' },
        {} as ScoutToolExecutionContext
      );
      expect(matchedRes.road_name_matched).toBe(true);
      expect(matchedRes.snapped_road_name).toBe('Interstate 40');
      expect(matchedRes.snapped_lat).toBe(35.2);
      expect(matchedRes.snapped_lng).toBe(-111.75);

      // When only I-405 is present for hint I-40, road_name_matched is false
      const mockUnmatchedFetch: typeof fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            code: 'Ok',
            waypoints: [{ name: 'I-405', location: [-111.76, 35.19], distance: 5 }],
          }),
          { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }
        );
      });
      const unmatchedLib = new ScoutToolLibrary({ fetchImpl: mockUnmatchedFetch });
      const unmatchedRes = await unmatchedLib.snapToHighwayCorridor(
        { lat: 35.195, lng: -111.755, road_name: 'I-40' },
        {} as ScoutToolExecutionContext
      );
      expect(unmatchedRes.road_name_matched).toBe(false);
      expect(unmatchedRes.snapped_road_name).toBe('I-405');
    });
});
