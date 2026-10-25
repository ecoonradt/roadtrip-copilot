import { describe, it, expect, vi } from 'vitest';
import {
  simulateScheduleCascadeTool,
  type ScheduleCascadeResult,
} from '../../server/services/scoutTools/scheduleSimulator.js';
import type { RouteService } from '../../server/services/routeService.js';
import type { ScoutToolExecutionContext, ScoutTripContext } from '../../server/services/scoutTools/types.js';
import type { RouteResponse } from '../../server/types/index.js';

const TRIP_DATE = '2026-07-01'; // Phoenix is UTC-7 (MST), Utah is UTC-6 (MDT)
const ST_GEORGE_LAT = 37.1;
const ST_GEORGE_LNG = -113.6;
const ORIGINAL_STOP_LAT = 36.91;
const ORIGINAL_STOP_LNG = -112.45;

function buildRouteResponse(distanceMiles: number, durationSeconds: number): RouteResponse {
  return {
    geometry: { type: 'LineString', coordinates: [] },
    distanceMeters: Math.round(distanceMiles * 1609.344),
    distanceMiles,
    durationSeconds,
    durationMinutes: Number((durationSeconds / 60).toFixed(1)),
    waypoints: [],
    legs: [],
    cached: false,
  };
}

type GetRouteFn = (
  coordsStr: string,
  customCalibration?: number,
  abortSignal?: AbortSignal
) => Promise<RouteResponse>;

interface RouteServiceMock {
  getRoute: ReturnType<typeof vi.fn<GetRouteFn>>;
  routeService: RouteService;
}

function createRouteServiceMock(
  resolver: (coordsStr: string) => RouteResponse = () => buildRouteResponse(180, 1800)
): RouteServiceMock {
  const getRoute = vi.fn<GetRouteFn>(async (coordsStr: string) => resolver(coordsStr));
  return { getRoute, routeService: { getRoute } as unknown as RouteService };
}

/**
 * Phoenix origin -> Arizona strip stop -> Moab destination.
 * The middle stop carries an explicit America/Phoenix zone at coordinates near the
 * Arizona/Utah border, and its incoming/outgoing legs are pre-measured so unchanged-leg
 * reuse is observable independently of routing.
 */
function buildTripContext(): ScoutTripContext {
  return {
    tripName: 'Arizona Strip to Moab',
    date: TRIP_DATE,
    origin: 'Phoenix, AZ',
    destination: 'Moab, UT',
    departureTime: '08:00:00',
    waypoints: [
      {
        id: 'wp_origin',
        name: 'Phoenix Departure',
        type: 'origin',
        lat: 33.4484,
        lng: -112.074,
        dwell_minutes: 0,
        timezone: 'America/Phoenix',
      },
      {
        id: 'wp_stop',
        name: 'Vermilion Cliffs Stop',
        type: 'scenic_pull_off',
        lat: ORIGINAL_STOP_LAT,
        lng: ORIGINAL_STOP_LNG,
        dwell_minutes: 30,
        drive_distance_miles: 250,
        drive_duration_minutes: 240,
        timezone: 'America/Phoenix',
      },
      {
        id: 'wp_dest',
        name: 'Moab Lodging',
        type: 'destination',
        lat: 38.5733,
        lng: -109.5498,
        dwell_minutes: 0,
        drive_distance_miles: 190,
        drive_duration_minutes: 200,
        timezone: 'America/Denver',
      },
    ],
  };
}

/** Two Utah stops used to observe the origin departure epoch after a move. */
function buildOriginMoveTripContext(): ScoutTripContext {
  return {
    tripName: 'Utah Local Clocks',
    date: TRIP_DATE,
    origin: 'Phoenix, AZ',
    destination: 'St. George, UT',
    departureTime: '08:00:00',
    waypoints: [
      {
        id: 'wp_origin',
        name: 'Phoenix Departure',
        type: 'origin',
        lat: 33.4484,
        lng: -112.074,
        dwell_minutes: 0,
        timezone: 'America/Phoenix',
      },
      {
        id: 'wp_dest',
        name: 'St. George Lodging',
        type: 'destination',
        lat: 37.0965,
        lng: -113.5684,
        dwell_minutes: 0,
        drive_distance_miles: 120,
        drive_duration_minutes: 110,
        timezone: 'America/Denver',
      },
    ],
  };
}

function stopById(result: ScheduleCascadeResult, id: string): ScheduleCascadeResult['stops'][number] {
  const stop = result.stops.find((s) => s.id === id);
  if (!stop) {
    throw new Error(`Expected stop "${id}" in simulation result`);
  }
  return stop;
}

describe('simulateScheduleCascadeTool timezone relocation', () => {
  it('relocates an Arizona stop into Utah and reports Utah local clocks plus crossing', async () => {
    const { getRoute, routeService } = createRouteServiceMock();
    const tripContext = buildTripContext();
    const context: ScoutToolExecutionContext = { tripContext };

    const result = await simulateScheduleCascadeTool(
      {
        action: 'update',
        target_waypoint_id: 'wp_stop',
        candidate_lat: ST_GEORGE_LAT,
        candidate_lng: ST_GEORGE_LNG,
        dwell_minutes: 30,
      },
      context,
      routeService
    );

    // 15:00 UTC = 08:00 Phoenix = 09:00 Denver: mock every leg at 1800s for an easy clock check.
    const originStop = stopById(result, 'wp_origin');
    const relocated = stopById(result, 'wp_stop');

    expect(originStop.timezone).toBe('America/Phoenix');
    expect(originStop.departure_time).toBe('08:00');
    expect(relocated.lat).toBe(ST_GEORGE_LAT);
    expect(relocated.lng).toBe(ST_GEORGE_LNG);
    expect(relocated.timezone).toBe('America/Denver');
    // 08:00 Phoenix (15:00 UTC) + 30 min = 15:30 UTC = 09:30 in Utah, not 08:30.
    expect(relocated.arrival_time).toBe('09:30');
    expect(relocated.departure_time).toBe('10:00');
    expect(result.timezones_crossed).toEqual(['America/Phoenix', 'America/Denver']);
    expect(result.start_time).toBe('08:00');
    expect(getRoute).toHaveBeenCalledTimes(2);
  });

  it('initializes the origin departure zone when the origin itself is relocated', async () => {
    const { getRoute, routeService } = createRouteServiceMock();
    const tripContext = buildOriginMoveTripContext();
    const context: ScoutToolExecutionContext = { tripContext };

    const result = await simulateScheduleCascadeTool(
      {
        action: 'update',
        target_waypoint_id: 'wp_origin',
        candidate_lat: ST_GEORGE_LAT,
        candidate_lng: ST_GEORGE_LNG,
      },
      context,
      routeService
    );

    const movedOrigin = stopById(result, 'wp_origin');
    const destination = stopById(result, 'wp_dest');

    expect(movedOrigin.timezone).toBe('America/Denver');
    expect(movedOrigin.departure_time).toBe('08:00');
    // 08:00 Denver (14:00 UTC) + 30 min = 08:30 Denver. A stale Phoenix origin would say 09:30.
    expect(destination.arrival_time).toBe('08:30');
    expect(result.start_time).toBe('08:00');
    expect(result.timezones_crossed).toEqual(['America/Denver']);
    expect(getRoute).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicit original zone for dwell-only and name-only updates', async () => {
    const { getRoute, routeService } = createRouteServiceMock();
    const tripContext = buildTripContext();
    const context: ScoutToolExecutionContext = { tripContext };

    const dwellOnly = await simulateScheduleCascadeTool(
      { action: 'update', target_waypoint_id: 'wp_stop', dwell_minutes: 75 },
      context,
      routeService
    );
    const dwellStop = stopById(dwellOnly, 'wp_stop');
    expect(dwellStop.timezone).toBe('America/Phoenix');
    expect(dwellStop.dwell_minutes).toBe(75);
    expect(dwellOnly.stops.map((s) => s.timezone)).toEqual([
      'America/Phoenix',
      'America/Phoenix',
      'America/Denver',
    ]);

    const nameOnly = await simulateScheduleCascadeTool(
      { action: 'update', target_waypoint_id: 'wp_stop', candidate_name: 'Vermilion Cliffs Overlook' },
      context,
      routeService
    );
    expect(stopById(nameOnly, 'wp_stop').timezone).toBe('America/Phoenix');
    expect(stopById(nameOnly, 'wp_stop').name).toBe('Vermilion Cliffs Overlook');

    // Both edits left every coordinate untouched, so no leg was re-routed.
    expect(getRoute).not.toHaveBeenCalled();
  });

  it('preserves an explicit original zone when candidate coordinates are unchanged', async () => {
    const { getRoute, routeService } = createRouteServiceMock();
    const tripContext = buildTripContext();
    const context: ScoutToolExecutionContext = { tripContext };

    const result = await simulateScheduleCascadeTool(
      {
        action: 'update',
        target_waypoint_id: 'wp_stop',
        candidate_lat: ORIGINAL_STOP_LAT,
        candidate_lng: ORIGINAL_STOP_LNG,
        dwell_minutes: 45,
      },
      context,
      routeService
    );

    const stop = stopById(result, 'wp_stop');
    expect(stop.timezone).toBe('America/Phoenix');
    expect(stop.arrival_time).toBe('12:00'); // 08:00 + 240 min unchanged inbound leg
    expect(getRoute).not.toHaveBeenCalled();
  });

  it('recomputes the zone from coordinates regardless of the previous explicit zone', async () => {
    const { routeService } = createRouteServiceMock();
    const tripContext = buildTripContext();
    const stop = tripContext.waypoints[1];
    stop.timezone = 'America/Denver';
    const context: ScoutToolExecutionContext = { tripContext };

    const result = await simulateScheduleCascadeTool(
      {
        action: 'update',
        target_waypoint_id: 'wp_stop',
        candidate_lat: 33.4484,
        candidate_lng: -112.074,
      },
      context,
      routeService
    );

    expect(stopById(result, 'wp_stop').timezone).toBe('America/Phoenix');
  });

  it('routes only the legs touched by a relocation and reuses unchanged legs', async () => {
    const { getRoute, routeService } = createRouteServiceMock();
    const tripContext = buildTripContext();
    const context: ScoutToolExecutionContext = { tripContext };

    // Relocating the middle stop changes both its inbound and outbound legs.
    await simulateScheduleCascadeTool(
      {
        action: 'update',
        target_waypoint_id: 'wp_stop',
        candidate_lat: ST_GEORGE_LAT,
        candidate_lng: ST_GEORGE_LNG,
      },
      context,
      routeService
    );
    expect(getRoute).toHaveBeenCalledTimes(2);

    getRoute.mockClear();

    // Deleting the middle stop bridges origin -> destination, touching only that new leg.
    const deleteResult = await simulateScheduleCascadeTool(
      { action: 'delete', target_waypoint_id: 'wp_stop' },
      context,
      routeService
    );
    expect(getRoute).toHaveBeenCalledTimes(1);
    expect(stopById(deleteResult, 'wp_origin').timezone).toBe('America/Phoenix');
    expect(stopById(deleteResult, 'wp_dest').timezone).toBe('America/Denver');
    expect(deleteResult.timezones_crossed).toEqual(['America/Phoenix', 'America/Denver']);
  });

  it('adds a Utah stop with its own detected zone while preserving zero dwell', async () => {
    const { getRoute, routeService } = createRouteServiceMock();
    const tripContext = buildTripContext();
    const originalSnapshot = JSON.stringify(tripContext.waypoints);
    const context: ScoutToolExecutionContext = { tripContext };

    const result = await simulateScheduleCascadeTool(
      {
        action: 'add',
        target_waypoint_id: 'wp_stop',
        candidate_lat: ST_GEORGE_LAT,
        candidate_lng: ST_GEORGE_LNG,
        candidate_name: 'Snow Canyon Overlook',
        candidate_type: 'scenic_pull_off',
        dwell_minutes: 0,
      },
      context,
      routeService
    );

    const added = result.stops.find((s) => s.name === 'Snow Canyon Overlook');
    expect(added).toBeDefined();
    expect(added?.timezone).toBe('America/Denver');
    expect(added?.dwell_minutes).toBe(0);
    // Existing inbound leg is reused; the two legs around the insertion are routed.
    expect(getRoute).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(tripContext.waypoints)).toBe(originalSnapshot);
  });

  it('forwards the caller abort signal and literal OSRM delimiters on relocated legs', async () => {
    const { getRoute, routeService } = createRouteServiceMock();
    const tripContext = buildTripContext();
    const controller = new AbortController();
    const context: ScoutToolExecutionContext = {
      tripContext,
      abortSignal: controller.signal,
    };

    await simulateScheduleCascadeTool(
      {
        action: 'update',
        target_waypoint_id: 'wp_stop',
        candidate_lat: ST_GEORGE_LAT,
        candidate_lng: ST_GEORGE_LNG,
      },
      context,
      routeService
    );

    expect(getRoute).toHaveBeenCalledTimes(2);
    for (const call of getRoute.mock.calls) {
      const [coordsStr, customCalibration, abortSignal] = call;
      expect(coordsStr).toMatch(/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?;-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/);
      expect(coordsStr).toContain(';');
      expect(coordsStr).not.toContain('%3B');
      expect(coordsStr).not.toContain('%2C');
      expect(customCalibration).toBeUndefined();
      expect(abortSignal).toBe(controller.signal);
    }
    expect(getRoute.mock.calls[0][0]).toBe(`-112.074,33.4484;${ST_GEORGE_LNG},${ST_GEORGE_LAT}`);
    expect(getRoute.mock.calls[1][0]).toBe(`${ST_GEORGE_LNG},${ST_GEORGE_LAT};-109.5498,38.5733`);
  });

  it('propagates caller aborts from the routing layer without inventing times', async () => {
    const abortError = new Error('The operation was aborted');
    const getRoute = vi.fn<GetRouteFn>(async () => {
      throw abortError;
    });
    const routeService = { getRoute } as unknown as RouteService;
    const tripContext = buildTripContext();
    const controller = new AbortController();
    const context: ScoutToolExecutionContext = {
      tripContext,
      abortSignal: controller.signal,
    };

    await expect(
      simulateScheduleCascadeTool(
        {
          action: 'update',
          target_waypoint_id: 'wp_stop',
          candidate_lat: ST_GEORGE_LAT,
          candidate_lng: ST_GEORGE_LNG,
        },
        context,
        routeService
      )
    ).rejects.toThrow('The operation was aborted');
    expect(getRoute).toHaveBeenCalled();
    expect(getRoute.mock.calls[0][2]).toBe(controller.signal);
  });

  it('never mutates the caller trip context while relocating coordinates', async () => {
    const { routeService } = createRouteServiceMock();
    const tripContext = buildTripContext();
    const inputSnapshot = JSON.stringify(tripContext);
    const context: ScoutToolExecutionContext = { tripContext };

    const result = await simulateScheduleCascadeTool(
      {
        action: 'update',
        target_waypoint_id: 'wp_stop',
        candidate_lat: ST_GEORGE_LAT,
        candidate_lng: ST_GEORGE_LNG,
        dwell_minutes: 15,
      },
      context,
      routeService
    );

    expect(JSON.stringify(tripContext)).toBe(inputSnapshot);
    const originalStop = tripContext.waypoints[1];
    expect(originalStop.lat).toBe(ORIGINAL_STOP_LAT);
    expect(originalStop.lng).toBe(ORIGINAL_STOP_LNG);
    expect(originalStop.dwell_minutes).toBe(30);
    expect(originalStop.timezone).toBe('America/Phoenix');

    // The result reflects the simulated edit without writing back into the input.
    expect(stopById(result, 'wp_stop').lat).toBe(ST_GEORGE_LAT);
    expect(stopById(result, 'wp_stop').dwell_minutes).toBe(15);
  });
});
