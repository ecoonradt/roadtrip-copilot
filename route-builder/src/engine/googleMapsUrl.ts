import type {
  CoordinateLocation,
  GoogleMapsLeg,
  GoogleMapsRouteResult,
  GoogleMapsUrlOptions,
} from './types';

/**
 * Google Maps Navigation URL base endpoint.
 */
export const GOOGLE_MAPS_DIR_BASE = 'https://www.google.com/maps/dir/?api=1';

/**
 * Maximum intermediate waypoints allowed by Google Maps URL API in a single navigation link.
 * Total points per URL is 11 (1 origin + up to 9 intermediate + 1 destination).
 */
export const MAX_INTERMEDIATE_WAYPOINTS = 9;

/**
 * Default titles for multi-leg driving days.
 */
const DEFAULT_TITLES_BY_COUNT: Record<number, string[]> = {
  1: ['Full Route'],
  2: ['Leg 1 (Morning)', 'Leg 2 (Afternoon)'],
  3: ['Leg 1 (Morning)', 'Leg 2 (Midday)', 'Leg 3 (Afternoon)'],
  4: ['Leg 1 (Morning)', 'Leg 2 (Midday)', 'Leg 3 (Afternoon)', 'Leg 4 (Evening)'],
};

/**
 * Formats a single coordinate pair as "lat,lng" for query parameter insertion.
 */
export function formatCoord(lat: number, lng: number): string {
  // Truncate to at most 6 decimal places to prevent floating point noise while preserving sub-meter precision
  const cleanLat = Number(lat.toFixed(6));
  const cleanLng = Number(lng.toFixed(6));
  return `${cleanLat},${cleanLng}`;
}

/**
 * Determines if a waypoint represents a physical stopping location (dwell > 0, lodging, meal, fuel, pull-off).
 * Generic untyped points without dwell default to true to preserve backward compatibility with raw coordinate arrays.
 */
export function isPhysicalStop(loc: CoordinateLocation): boolean {
  if (
    loc.type === 'scenic_drive_by' ||
    (loc.dwellMinutes === 0 && loc.type !== 'lodging' && loc.type !== 'destination' && loc.type !== 'origin')
  ) {
    return false;
  }
  return true;
}

/**
 * Cleans a waypoint name for search queries by:
 * 1. Stripping leg prefixes (e.g. "Flagstaff / Little America Hotel" -> "Little America Hotel").
 * 2. Stripping trailing parenthetical notes (e.g. "Maverik (West Main St)" -> "Maverik", "Red Rock Park (Picnic & Stretch)" -> "Red Rock Park").
 */
export function extractCleanPlaceName(name: string): string {
  if (!name) return '';
  let trimmed = name.trim();
  if (trimmed.includes('/')) {
    const afterSlash = trimmed.split('/').pop()!.trim();
    if (afterSlash.length > 0) trimmed = afterSlash;
  }
  // Strip trailing parenthetical qualifiers (e.g. "(West Main St)", "(US-491)")
  trimmed = trimmed.replace(/\s*\([^)]*\)\s*$/g, '').trim();
  return trimmed;
}

/**
 * Formats a location as a query string parameter for Google Maps navigation.
 * - Prioritizes explicit `loc.placeName` (clean establishment name) over `loc.name`.
 * - When place name and address are both available, combines them (e.g. "Little America Hotel, 2515 E Butler Ave, Flagstaff, AZ")
 *   so Google Maps displays the establishment name as the destination title while locking to the exact place.
 * - In-transit pass-through anchors and scenic drive-bys (dwell == 0) MUST ALWAYS format as exact coordinates (lat,lng)
 *   to prevent Google Maps from searching for non-existent businesses or snapping to Airbnbs/side-streets.
 */
export function formatLocationQuery(loc: CoordinateLocation): string {
  if (!isPhysicalStop(loc) || loc.isRouteAnchor === true) {
    return formatCoord(loc.lat, loc.lng);
  }

  const cleanName =
    loc.placeName && loc.placeName.trim().length > 0
      ? loc.placeName.trim()
      : loc.name
      ? extractCleanPlaceName(loc.name)
      : '';

  if (cleanName && loc.address && loc.address.trim().length > 0) {
    const addr = loc.address.trim();
    if (!addr.toLowerCase().includes(cleanName.toLowerCase())) {
      return encodeURIComponent(`${cleanName}, ${addr}`);
    }
    return encodeURIComponent(addr);
  }

  if (cleanName && loc.placeId && loc.placeId.trim().length > 0) {
    return encodeURIComponent(cleanName);
  }

  if (loc.address && loc.address.trim().length > 0) {
    return encodeURIComponent(loc.address.trim());
  }

  return formatCoord(loc.lat, loc.lng);
}

/**
 * Filters a sequence of waypoints for Google Maps Navigation.
 * - Always includes Origin (first point) and Destination (last point).
 * - For intermediate points:
 *   - Explicit route anchors (isRouteAnchor === true) are always included.
 *   - Explicit non-anchors with dwell 0 (isRouteAnchor === false) are excluded.
 *   - Physical stops (dwell > 0 or physical stop categories) are included.
 *   - Legacy / un-audited routes (isRouteAnchor === undefined):
 *     Preserves the first in-transit scenic drive-by along a corridor as an auto-anchor to prevent highway shortcutting.
 */
export function filterWaypointsForNavigation(
  waypoints: CoordinateLocation[]
): CoordinateLocation[] {
  if (!waypoints || waypoints.length <= 2) {
    return waypoints ? [...waypoints] : [];
  }

  const origin = waypoints[0];
  const destination = waypoints[waypoints.length - 1];
  const intermediates = waypoints.slice(1, -1);

  const selectedIntermediates: CoordinateLocation[] = [];
  let pendingDriveBys: CoordinateLocation[] = [];

  for (const wp of intermediates) {
    if (wp.isRouteAnchor === true) {
      selectedIntermediates.push(wp);
      pendingDriveBys = [];
    } else if (wp.isRouteAnchor === false) {
      if (isPhysicalStop(wp)) {
        selectedIntermediates.push(wp);
        pendingDriveBys = [];
      }
    } else {
      // isRouteAnchor is undefined (legacy / default)
      if (isPhysicalStop(wp)) {
        if (pendingDriveBys.length > 0) {
          selectedIntermediates.push(pendingDriveBys[0]);
          pendingDriveBys = [];
        }
        selectedIntermediates.push(wp);
      } else {
        pendingDriveBys.push(wp);
      }
    }
  }

  if (pendingDriveBys.length > 0) {
    selectedIntermediates.push(pendingDriveBys[0]);
  }

  return [origin, ...selectedIntermediates, destination];
}

function shouldEmitPlaceId(loc: CoordinateLocation): boolean {
  return (
    isPhysicalStop(loc) &&
    loc.isRouteAnchor !== true &&
    Boolean(loc.placeId && loc.placeId.trim().length > 0)
  );
}

/**
 * Constructs a single valid Google Maps Navigation URL.
 * Format:
 * https://www.google.com/maps/dir/?api=1&origin={query}&origin_place_id={id}&destination={query}&destination_place_id={id}&waypoints={query}|{query}&waypoint_place_ids={id}|{id}&travelmode=driving
 */
export function buildSingleGoogleMapsUrl(
  origin: CoordinateLocation,
  destination: CoordinateLocation,
  intermediateWaypoints: CoordinateLocation[] = []
): string {
  const originQuery = formatLocationQuery(origin);
  const destQuery = formatLocationQuery(destination);

  let url = `${GOOGLE_MAPS_DIR_BASE}&origin=${originQuery}`;
  if (shouldEmitPlaceId(origin) && origin.placeId) {
    url += `&origin_place_id=${encodeURIComponent(origin.placeId.trim())}`;
  }

  url += `&destination=${destQuery}`;
  if (shouldEmitPlaceId(destination) && destination.placeId) {
    url += `&destination_place_id=${encodeURIComponent(destination.placeId.trim())}`;
  }

  if (intermediateWaypoints.length > 0) {
    const waypointsParam = intermediateWaypoints
      .map((w) => formatLocationQuery(w))
      .join('|');
    url += `&waypoints=${waypointsParam}`;

    const hasAnyPlaceId = intermediateWaypoints.some(shouldEmitPlaceId);
    if (hasAnyPlaceId) {
      const placeIdsParam = intermediateWaypoints
        .map((w) =>
          shouldEmitPlaceId(w) && w.placeId
            ? encodeURIComponent(w.placeId.trim())
            : ''
        )
        .join('|');
      url += `&waypoint_place_ids=${placeIdsParam}`;
    }
  }

  url += '&travelmode=driving';
  return url;
}

/**
 * Resolves a human-readable title for a partitioned leg.
 */
function resolveLegTitle(
  legIndex: number,
  totalLegs: number,
  customTitles?: string[]
): string {
  if (customTitles && customTitles[legIndex]) {
    return customTitles[legIndex];
  }

  const presets = DEFAULT_TITLES_BY_COUNT[totalLegs];
  if (presets && presets[legIndex]) {
    return presets[legIndex];
  }

  return `Leg ${legIndex + 1} (Part ${legIndex + 1})`;
}

/**
 * Generates Google Maps navigation link(s) for a sequence of waypoints.
 * - For <= 11 waypoints (at most 9 intermediate stops), generates a single navigation URL.
 * - For > 11 waypoints, automatically partitions the route into logical legs with continuity:
 *   Leg 1 has origin W0, destination W10, and intermediate waypoints W1..W9 (9 intermediate points).
 *   Leg 2 starts at W10 (continuity), destination WN, and intermediate waypoints up to 9.
 */
export function generateGoogleMapsUrls(
  waypoints: CoordinateLocation[],
  options?: GoogleMapsUrlOptions
): GoogleMapsRouteResult {
  if (!waypoints || waypoints.length === 0) {
    return {
      legs: [],
      totalLegs: 0,
      primaryUrl: '',
    };
  }

  const navPoints = options?.skipNavFiltering
    ? waypoints
    : filterWaypointsForNavigation(waypoints);

  // Handle single waypoint case
  if (navPoints.length === 1) {
    const singlePoint = navPoints[0];
    const url = buildSingleGoogleMapsUrl(singlePoint, singlePoint, []);
    const singleLeg: GoogleMapsLeg = {
      legIndex: 0,
      legNumber: 1,
      title: options?.customLegTitles?.[0] || 'Single Waypoint',
      origin: singlePoint,
      destination: singlePoint,
      intermediateWaypoints: [],
      waypointCount: 1,
      url,
    };
    return {
      legs: [singleLeg],
      totalLegs: 1,
      primaryUrl: url,
    };
  }

  const maxIntermediate =
    options?.maxIntermediateWaypoints ?? MAX_INTERMEDIATE_WAYPOINTS;
  // Step size from start of leg to end of leg is maxIntermediate + 1
  const maxLegStep = maxIntermediate + 1; // 10

  // First pass: compute leg index boundaries to know totalLegs count for title assignment
  const boundaries: Array<{ start: number; end: number }> = [];
  let currentStart = 0;
  const n = navPoints.length;

  while (currentStart < n - 1) {
    const nextEnd = Math.min(currentStart + maxLegStep, n - 1);
    boundaries.push({ start: currentStart, end: nextEnd });
    currentStart = nextEnd;
  }

  const totalLegs = boundaries.length;
  const legs: GoogleMapsLeg[] = [];

  for (let i = 0; i < boundaries.length; i++) {
    const { start, end } = boundaries[i];
    const origin = navPoints[start];
    const destination = navPoints[end];
    const intermediateWaypoints = navPoints.slice(start + 1, end);
    const waypointCount = end - start + 1;

    const title = resolveLegTitle(i, totalLegs, options?.customLegTitles);
    const url = buildSingleGoogleMapsUrl(origin, destination, intermediateWaypoints);

    legs.push({
      legIndex: i,
      legNumber: i + 1,
      title,
      origin,
      destination,
      intermediateWaypoints,
      waypointCount,
      url,
    });
  }

  return {
    legs,
    totalLegs,
    primaryUrl: legs[0]?.url || '',
  };
}
