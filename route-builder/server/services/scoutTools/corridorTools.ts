import type { RouteService } from '../routeService.js';
import { isValidGooglePlaceId } from '../placeId.js';
import { matchesHighwayRoadName } from './geo.js';
import {
  OSRM_NEAREST_BASE_URL,
  MAX_AUDIT_WAYPOINTS,
  MAX_AUDIT_CONCURRENCY,
  type ScoutToolExecutionContext,
  type FetchJsonWithTimeoutFn,
  type ScoutWaypointSummary,
} from './types.js';

export const PAST_PRESENT_VERBS_REGEX =
  /\b(?:now cruising|currently passing|currently driving)\b/i;
export const PAST_PRESENT_PREFIX_REGEX = /^(?:driving past|passing by)\b/i;

export const CATEGORY_CONFLICTS = {
  fuelTokens: /\b(?:fuel|gas|gasoline|petrol)\b/,
  mealTokens: /\b(?:meal|lunch|dinner|breakfast)\b/,
};

export const AUDIT_CONCURRENCY = MAX_AUDIT_CONCURRENCY;

interface RawOsrmNearestResponse {
  code?: string;
  waypoints?: Array<{
    distance?: number;
    name?: string;
    location: [number, number]; // [lon, lat]
  }>;
}

export interface SnapToHighwayCorridorDeps {
  osrmNearestBaseUrl: string;
  fetchJsonWithTimeout: FetchJsonWithTimeoutFn;
}

export interface SnapToHighwayCorridorResult {
  snapped_lat: number;
  snapped_lng: number;
  snapped_road_name: string;
  distance_from_input_meters: number;
  distance_from_input_miles: number;
  road_name_matched?: boolean;
  candidates: Array<{
    lat: number;
    lng: number;
    road_name: string;
    distance_meters: number;
  }>;
}

/**
 * Snaps coordinates to the nearest active highway centerline using OSRM to ensure
 * drive-by waypoints and scenic triggers do not depart the highway onto service roads or residential streets.
 */
export async function snapToHighwayCorridorTool(
  args: Record<string, unknown>,
  context: ScoutToolExecutionContext,
  deps: SnapToHighwayCorridorDeps
): Promise<SnapToHighwayCorridorResult> {
  if (typeof args.lat !== 'number' || !Number.isFinite(args.lat) || args.lat < -90 || args.lat > 90) {
    throw new Error('Invalid or out-of-bounds latitude [-90, 90]');
  }
  if (typeof args.lng !== 'number' || !Number.isFinite(args.lng) || args.lng < -180 || args.lng > 180) {
    throw new Error('Invalid or out-of-bounds longitude [-180, 180]');
  }

  const baseUrl = deps.osrmNearestBaseUrl || OSRM_NEAREST_BASE_URL;
  const coordSegment = `${Number(args.lng.toFixed(6))},${Number(args.lat.toFixed(6))}`;
  // Preserve literal comma in OSRM URL path (Rule 5)
  const url = `${baseUrl}/${coordSegment}?number=5`;

  const data = await deps.fetchJsonWithTimeout<RawOsrmNearestResponse>(
    url,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    },
    'OSRM nearest',
    context.abortSignal
  );

  if (data.code !== 'Ok' || !Array.isArray(data.waypoints) || data.waypoints.length === 0) {
    throw new Error('OSRM nearest returned no highway candidates');
  }

  const roadName = typeof args.road_name === 'string' ? args.road_name.trim() : '';
  let selected = data.waypoints[0];
  let road_name_matched: boolean | undefined = undefined;

  if (roadName) {
    const matched = data.waypoints.find((wp) => matchesHighwayRoadName(wp.name || '', roadName));
    if (matched) {
      selected = matched;
      road_name_matched = true;
    } else {
      road_name_matched = false;
    }
  }

  return {
    snapped_lat: Number(selected.location[1].toFixed(6)),
    snapped_lng: Number(selected.location[0].toFixed(6)),
    snapped_road_name: selected.name || '',
    distance_from_input_meters: Math.round(selected.distance ?? 0),
    distance_from_input_miles: Number(((selected.distance ?? 0) / 1609.344).toFixed(3)),
    road_name_matched,
    candidates: data.waypoints.map((wp) => ({
      lat: Number(wp.location[1].toFixed(6)),
      lng: Number(wp.location[0].toFixed(6)),
      road_name: wp.name || '',
      distance_meters: Math.round(wp.distance ?? 0),
    })),
  };
}

export interface DetourImpactResult {
  after_waypoint_id: string;
  preceding_waypoint_id: string;
  following_waypoint_id?: string;
  baseline_leg_miles: number;
  baseline_leg_minutes: number;
  detour_leg_miles: number;
  detour_leg_minutes: number;
  added_distance_miles: number;
  added_duration_minutes: number;
}

/**
 * Calculates the exact added driving distance and duration for inserting a candidate waypoint
 * into the active route corridor using OSRM.
 */
export async function calculateDetourImpactTool(
  args: Record<string, unknown>,
  context: ScoutToolExecutionContext,
  routeService: RouteService
): Promise<DetourImpactResult> {
  if (
    typeof args.candidate_lat !== 'number' ||
    !Number.isFinite(args.candidate_lat) ||
    args.candidate_lat < -90 ||
    args.candidate_lat > 90
  ) {
    throw new Error('Invalid or out-of-bounds candidate_lat [-90, 90]');
  }
  if (
    typeof args.candidate_lng !== 'number' ||
    !Number.isFinite(args.candidate_lng) ||
    args.candidate_lng < -180 ||
    args.candidate_lng > 180
  ) {
    throw new Error('Invalid or out-of-bounds candidate_lng [-180, 180]');
  }
  const afterId = typeof args.after_waypoint_id === 'string' ? args.after_waypoint_id.trim() : '';
  if (!afterId) {
    throw new Error('Missing required "after_waypoint_id" argument');
  }

  const waypoints = context.tripContext?.waypoints;
  if (!Array.isArray(waypoints) || waypoints.length === 0) {
    throw new Error('Trip context contains no waypoints');
  }

  const idx = waypoints.findIndex((w) => w.id === afterId);
  if (idx === -1) {
    throw new Error(
      `Waypoint "${afterId}" not found in active trip context. Available IDs: ${waypoints.map((w) => w.id).join(', ')}`
    );
  }

  const prevWp = waypoints[idx];
  const candLng = Number(args.candidate_lng.toFixed(6));
  const candLat = Number(args.candidate_lat.toFixed(6));

  if (idx < waypoints.length - 1) {
    const nextWp = waypoints[idx + 1];
    const [baseRoute, detourRoute] = await Promise.all([
      routeService.getRoute(
        `${Number(prevWp.lng.toFixed(6))},${Number(prevWp.lat.toFixed(6))};${Number(nextWp.lng.toFixed(6))},${Number(nextWp.lat.toFixed(6))}`,
        undefined,
        context.abortSignal
      ),
      routeService.getRoute(
        `${Number(prevWp.lng.toFixed(6))},${Number(prevWp.lat.toFixed(6))};${candLng},${candLat};${Number(nextWp.lng.toFixed(6))},${Number(nextWp.lat.toFixed(6))}`,
        undefined,
        context.abortSignal
      ),
    ]);

    const added_distance_miles = Number((detourRoute.distanceMiles - baseRoute.distanceMiles).toFixed(2));
    const added_duration_minutes = Number((detourRoute.durationMinutes - baseRoute.durationMinutes).toFixed(1));

    return {
      after_waypoint_id: afterId,
      preceding_waypoint_id: prevWp.id,
      following_waypoint_id: nextWp.id,
      baseline_leg_miles: baseRoute.distanceMiles,
      baseline_leg_minutes: baseRoute.durationMinutes,
      detour_leg_miles: detourRoute.distanceMiles,
      detour_leg_minutes: detourRoute.durationMinutes,
      added_distance_miles,
      added_duration_minutes,
    };
  }

  // Appending after final stop
  const legRoute = await routeService.getRoute(
    `${Number(prevWp.lng.toFixed(6))},${Number(prevWp.lat.toFixed(6))};${candLng},${candLat}`,
    undefined,
    context.abortSignal
  );

  return {
    after_waypoint_id: afterId,
    preceding_waypoint_id: prevWp.id,
    following_waypoint_id: undefined,
    baseline_leg_miles: 0,
    baseline_leg_minutes: 0,
    detour_leg_miles: legRoute.distanceMiles,
    detour_leg_minutes: legRoute.durationMinutes,
    added_distance_miles: legRoute.distanceMiles,
    added_duration_minutes: legRoute.durationMinutes,
  };
}

export interface AuditCorridorWaypointsDeps {
  osrmNearestBaseUrl: string;
  fetchJsonWithTimeout: FetchJsonWithTimeoutFn;
}

export interface AuditedWaypointRecord {
  id: string;
  name: string;
  type: string;
  lat: number;
  lng: number;
  distance_from_road_meters: number;
  nearest_road_name: string;
  issues: string[];
}

export interface AuditCorridorWaypointsResult {
  waypoint_count: number;
  flagged_count: number;
  waypoints: AuditedWaypointRecord[];
}

/**
 * Audits all waypoints along the active corridor for highway alignment, low-speed detour anomalies,
 * invalid Google Place IDs, physical stop metadata, and speech/alert consistency.
 */
export async function auditCorridorWaypointsTool(
  args: Record<string, unknown>,
  context: ScoutToolExecutionContext,
  deps: AuditCorridorWaypointsDeps
): Promise<AuditCorridorWaypointsResult> {
  if (args.day_number !== undefined && args.day_number !== null) {
    if (typeof args.day_number !== 'number' || !Number.isInteger(args.day_number) || args.day_number < 1) {
      throw new Error('Invalid day_number for audit_corridor_waypoints: must be a positive integer');
    }
    if (
      context.scope?.type === 'day' &&
      typeof context.scope.dayNumber === 'number' &&
      args.day_number !== context.scope.dayNumber
    ) {
      throw new Error(
        `Requested day_number ${args.day_number} does not match active scope Day ${context.scope.dayNumber}`
      );
    }
  }

  const waypoints = context.tripContext?.waypoints;
  if (!Array.isArray(waypoints)) {
    throw new Error('Trip context waypoints must be an array');
  }
  if (waypoints.length > MAX_AUDIT_WAYPOINTS) {
    throw new Error(`Corridor audit exceeds maximum waypoint limit (${MAX_AUDIT_WAYPOINTS})`);
  }

  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    if (!wp || typeof wp.id !== 'string' || !wp.id.trim() || typeof wp.name !== 'string') {
      throw new Error(`Invalid waypoint metadata at index ${i}`);
    }
    if (
      typeof wp.lat !== 'number' ||
      !Number.isFinite(wp.lat) ||
      wp.lat < -90 ||
      wp.lat > 90 ||
      typeof wp.lng !== 'number' ||
      !Number.isFinite(wp.lng) ||
      wp.lng < -180 ||
      wp.lng > 180
    ) {
      throw new Error(`Invalid coordinates on waypoint "${wp.id}": lat/lng must be finite numbers in bounds`);
    }
  }

  const baseUrl = deps.osrmNearestBaseUrl || OSRM_NEAREST_BASE_URL;
  const auditResults = new Array<AuditedWaypointRecord>(waypoints.length);

  let nextIndex = 0;
  const workerCount = Math.min(AUDIT_CONCURRENCY, Math.max(1, waypoints.length));

  const auditSingleWaypoint = async (wp: ScoutWaypointSummary): Promise<AuditedWaypointRecord> => {
    const coordSegment = `${Number(wp.lng.toFixed(6))},${Number(wp.lat.toFixed(6))}`;
    const url = `${baseUrl}/${coordSegment}?number=1`;
    const data = await deps.fetchJsonWithTimeout<RawOsrmNearestResponse>(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
      'OSRM nearest',
      context.abortSignal
    );

    if (data.code !== 'Ok' || !Array.isArray(data.waypoints) || data.waypoints.length === 0) {
      throw new Error('OSRM nearest returned no highway candidates');
    }

    const distanceFromRoadMeters = Math.round(data.waypoints[0].distance ?? 0);
    const nearestRoadName = data.waypoints[0].name || '';

    const issues: string[] = [];

    // 1. Off-highway drive-by
    const isDriveBy = wp.type === 'scenic_drive_by' || (wp.dwell_minutes === 0 && Boolean(wp.is_route_anchor));
    if (isDriveBy && distanceFromRoadMeters > 75) {
      issues.push(
        `off_highway_drive_by: placed ${distanceFromRoadMeters}m from nearest road "${nearestRoadName || 'unknown'}" (must be <= 75m directly on highway)`
      );
    }

    // 2. Low leg speed anomaly (< 30 mph over >= 2 miles)
    if (
      wp.drive_distance_miles !== undefined &&
      wp.drive_distance_miles >= 2 &&
      wp.drive_speed_mph !== undefined &&
      wp.drive_speed_mph < 30
    ) {
      issues.push(
        `low_leg_speed_anomaly: average speed ${wp.drive_speed_mph} mph over ${wp.drive_distance_miles} miles indicates off-highway dirt road detour`
      );
    }

    // 3. Invalid Google Place ID
    if (typeof wp.google_place_id === 'string' && wp.google_place_id.trim().length > 0) {
      if (!isValidGooglePlaceId(wp.google_place_id)) {
        issues.push(`invalid_google_place_id: "${wp.google_place_id}" failed binary protobuf structural validation`);
      }
    }

    // 4. Physical stop checks
    const isPhysical =
      wp.type === 'meal' ||
      wp.type === 'fuel' ||
      wp.type === 'lodging' ||
      (wp.type === 'scenic_pull_off' && (wp.dwell_minutes ?? 0) > 0);

    if (isPhysical) {
      if (!wp.address || !wp.place_name) {
        issues.push('missing_physical_stop_metadata: physical stops require verified place_name and street address');
      }
      if (wp.is_route_anchor === true) {
        issues.push('invalid_route_anchor_on_physical_stop: physical stops must have is_route_anchor: false');
      }
    }

    // 5. Speech copy tense
    if (wp.notification?.speech) {
      const speech = wp.notification.speech;
      if (PAST_PRESENT_VERBS_REGEX.test(speech) || PAST_PRESENT_PREFIX_REGEX.test(speech.trim())) {
        issues.push('non_anticipatory_speech: proximity alerts must use anticipatory future phrasing');
      }
    }

    // 6. ID / Purpose category mismatch (using word-boundary tokens so "Las Vegas" never matches "gas")
    const idTokens = wp.id.toLowerCase().replace(/_/g, ' ');
    const speechLower = wp.notification?.speech?.toLowerCase() || '';
    const hasFuelToken =
      CATEGORY_CONFLICTS.fuelTokens.test(idTokens) || CATEGORY_CONFLICTS.fuelTokens.test(speechLower);
    const hasMealToken = CATEGORY_CONFLICTS.mealTokens.test(idTokens);
    if (hasFuelToken && wp.type === 'meal') {
      issues.push('category_notification_mismatch: waypoint type is "meal" but id or speech refers to fuel');
    } else if (hasMealToken && wp.type === 'fuel') {
      issues.push('category_notification_mismatch: waypoint type is "fuel" but id refers to meal/lunch');
    }

    return {
      id: wp.id,
      name: wp.name,
      type: wp.type,
      lat: wp.lat,
      lng: wp.lng,
      distance_from_road_meters: distanceFromRoadMeters,
      nearest_road_name: nearestRoadName,
      issues,
    };
  };

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < waypoints.length) {
        if (context.abortSignal?.aborted) {
          throw new Error('Request aborted');
        }
        const idx = nextIndex++;
        auditResults[idx] = await auditSingleWaypoint(waypoints[idx]);
      }
    })
  );

  const flaggedList = auditResults.filter((w) => w.issues.length > 0);

  return {
    waypoint_count: waypoints.length,
    flagged_count: flaggedList.length,
    waypoints: auditResults,
  };
}
