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
 * Constructs a single valid Google Maps Navigation URL.
 * Format:
 * https://www.google.com/maps/dir/?api=1&origin={lat},{lng}&destination={lat},{lng}&waypoints={lat},{lng}|{lat},{lng}&travelmode=driving
 */
export function buildSingleGoogleMapsUrl(
  origin: CoordinateLocation,
  destination: CoordinateLocation,
  intermediateWaypoints: CoordinateLocation[] = []
): string {
  const originCoord = formatCoord(origin.lat, origin.lng);
  const destCoord = formatCoord(destination.lat, destination.lng);

  let url = `${GOOGLE_MAPS_DIR_BASE}&origin=${originCoord}&destination=${destCoord}`;

  if (intermediateWaypoints.length > 0) {
    const waypointsParam = intermediateWaypoints
      .map((w) => formatCoord(w.lat, w.lng))
      .join('|');
    url += `&waypoints=${waypointsParam}`;
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

  // Handle single waypoint case
  if (waypoints.length === 1) {
    const singlePoint = waypoints[0];
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
  const n = waypoints.length;

  while (currentStart < n - 1) {
    const nextEnd = Math.min(currentStart + maxLegStep, n - 1);
    boundaries.push({ start: currentStart, end: nextEnd });
    currentStart = nextEnd;
  }

  const totalLegs = boundaries.length;
  const legs: GoogleMapsLeg[] = [];

  for (let i = 0; i < boundaries.length; i++) {
    const { start, end } = boundaries[i];
    const origin = waypoints[start];
    const destination = waypoints[end];
    const intermediateWaypoints = waypoints.slice(start + 1, end);
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
