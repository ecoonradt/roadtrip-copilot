import type { OsrmRawResponse, RouteResponse, OsrmRawStep } from '../types/index.js';
import { RouteCache, defaultRouteCache } from './routeCache.js';

export const OSRM_BASE_URL = 'https://router.project-osrm.org/route/v1/driving';

/**
 * Calibration factor applied to raw OSRM durations.
 *
 * OSRM's public demo server uses the European car.lua profile which:
 * 1. Multiplies all posted legal speed limits by speed_reduction = 0.8 (an automatic 20% penalty, 1/0.8 = 1.25x duration inflation).
 * 2. Defaults untagged rural highways to conservative European defaults (primary = 65 km/h / 40.4 mph, trunk = 85 km/h / 52.8 mph)
 *    rather than North American rural cruising speeds (60-65 mph on US highways, 75 mph on interstates).
 * 3. Adds aggressive turn and lane marking penalties.
 *
 * A calibration factor of 0.77 (or ~1.30x speedup) aligns OSRM driving durations with real-world Google Maps telemetry.
 */
export const OSRM_SPEED_CALIBRATION_FACTOR = 0.77;

/**
 * Normalizes an individual OSRM step duration using North American statutory highway rules.
 *
 * OSRM's public demo server uses the European car.lua profile which:
 * 1. Multiplies all speeds by speed_reduction = 0.8 (automatic 20% penalty).
 * 2. Defaults untagged rural highways (common in OpenStreetMap across North America) to conservative
 *    European rural defaults (primary = 65 km/h / 40.4 mph) rather than North American rural cruising speeds
 *    (60-65 mph on US highways, 70-75 mph on interstates).
 *
 * For designated Interstate, US, and State highway corridors outside of dense urban stop-and-go segments,
 * this normalizes durations to North American statutory cruising speeds.
 */
export function adjustStepDuration(
  step: OsrmRawStep,
  baselineCalibration = OSRM_SPEED_CALIBRATION_FACTOR
): number {
  const distMeters = step.distance;
  const distMiles = distMeters / 1609.344;
  const rawSec = step.duration;
  if (rawSec <= 0 || distMiles <= 0) return rawSec;

  const rawMph = distMiles / (rawSec / 3600);
  const ref = (step.ref || '').trim();
  const name = (step.name || '').trim();

  // All 50 US States, DC, PR, and 10 Canadian provinces/territories
  const STATE_AND_PROVINCE_CODES =
    'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC|PR|AB|BC|MB|NB|NL|NS|ON|PE|QC|SK|YT|NT|NU';

  const isInterstate = /(?:^|[;\s])I[- ]?\d+[A-Z]?\b/i.test(ref) || /\bInterstate\b/i.test(name);
  const isUsHighway =
    /(?:^|[;\s])US[- ]?\d+[A-Z]?\b/i.test(ref) || /\b(?:US|U\.S\.)[- ](?:Highway|Route|Hwy)\b/i.test(name);
  const isStateHighway =
    new RegExp(`(?:^|[;\\s])(?:${STATE_AND_PROVINCE_CODES}|SR|SH|SP|M|FM|RM)[- ]?\\d+[A-Z]?\\b`, 'i').test(ref) ||
    /\b(?:State (?:Route|Hwy|Highway|Road)|State Rd|Highway|Hwy|Parkway)\b/i.test(name);

  // For open rural highway stretches (>= 1.5 miles) where OSRM fell back to European defaults:
  if (distMiles >= 1.5) {
    if (isInterstate && rawMph < 65) {
      // Elevate to statutory Interstate cruising speed (70 mph)
      return Math.round((distMiles / 70) * 3600);
    }
    if (isUsHighway && rawMph < 55) {
      // Elevate to statutory US Highway rural cruising speed (62 mph)
      return Math.round((distMiles / 62) * 3600);
    }
    if (isStateHighway && rawMph < 50) {
      // Elevate to statutory State Highway cruising speed (58 mph)
      return Math.round((distMiles / 58) * 3600);
    }
  }

  // Non-highway steps, short urban steps (< 1.5 mi), and city intersections use baseline calibration
  return Math.round(rawSec * baselineCalibration);
}

export interface CoordinatePair {
  lon: number;
  lat: number;
}

export class RouteService {
  private readonly baseUrl: string;
  private readonly cache: RouteCache;
  private readonly calibrationFactor: number;

  constructor(
    baseUrl = OSRM_BASE_URL,
    cache = defaultRouteCache,
    calibrationFactor = OSRM_SPEED_CALIBRATION_FACTOR
  ) {
    this.baseUrl = baseUrl;
    this.cache = cache;
    this.calibrationFactor = calibrationFactor;
  }

  public parseAndValidateCoordinates(coordsStr: string): CoordinatePair[] {
    const trimmed = coordsStr.trim();
    if (!trimmed) {
      throw new Error('Coordinates string cannot be empty');
    }

    const pairs = trimmed.split(';').map((p) => p.trim()).filter(Boolean);
    if (pairs.length < 2) {
      throw new Error('Routing requires at least two coordinate waypoints separated by semicolon (e.g. "lon1,lat1;lon2,lat2")');
    }

    const parsedPairs: CoordinatePair[] = [];
    for (let i = 0; i < pairs.length; i++) {
      const parts = pairs[i].split(',').map((p) => p.trim());
      if (parts.length !== 2) {
        throw new Error(`Invalid waypoint format at position ${i + 1}: expected "lon,lat" but received "${pairs[i]}"`);
      }

      const lon = parseFloat(parts[0]);
      const lat = parseFloat(parts[1]);

      if (isNaN(lon) || isNaN(lat)) {
        throw new Error(`Coordinates at position ${i + 1} must be valid numbers: "${pairs[i]}"`);
      }

      if (lon < -180 || lon > 180) {
        throw new Error(`Longitude out of bounds [-180, 180] at position ${i + 1}: ${lon}`);
      }

      if (lat < -90 || lat > 90) {
        throw new Error(`Latitude out of bounds [-90, 90] at position ${i + 1}: ${lat}`);
      }

      parsedPairs.push({ lon, lat });
    }

    return parsedPairs;
  }

  public async getRoute(coordsStr: string, customCalibration?: number): Promise<RouteResponse> {
    const validPairs = this.parseAndValidateCoordinates(coordsStr);

    const effectiveCalibration =
      typeof customCalibration === 'number' && customCalibration > 0 && !isNaN(customCalibration)
        ? customCalibration
        : this.calibrationFactor;

    // Format coordinates as OSRM expects: {lon},{lat};{lon},{lat}...
    const formattedCoords = validPairs.map((p) => `${p.lon},${p.lat}`).join(';');
    const cacheKey = `${formattedCoords}@cal=${effectiveCalibration.toFixed(4)}`;

    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const url = `${this.baseUrl}/${formattedCoords}?overview=full&geometries=geojson&steps=true`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`OSRM routing failed with HTTP ${res.status}: ${res.statusText}`);
    }

    const data = (await res.json()) as OsrmRawResponse;

    if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
      const msg = data.message || data.code || 'Unknown routing failure';
      throw new Error(`OSRM returned error status: ${msg}`);
    }

    const primaryRoute = data.routes[0];
    const distanceMeters = Math.round(primaryRoute.distance);
    const distanceMiles = Number((distanceMeters / 1609.344).toFixed(2));

    const waypoints = data.waypoints?.map((wp) => ({
      name: wp.name,
      location: wp.location,
    }));

    const legs = primaryRoute.legs?.map((leg) => {
      const distMeters = Math.round(leg.distance);
      const durSec =
        leg.steps && leg.steps.length > 0
          ? leg.steps.reduce((acc, step) => acc + adjustStepDuration(step, effectiveCalibration), 0)
          : Math.round(leg.duration * effectiveCalibration);
      return {
        distanceMeters: distMeters,
        distanceMiles: Number((distMeters / 1609.344).toFixed(2)),
        durationSeconds: durSec,
        durationMinutes: Number((durSec / 60).toFixed(1)),
        summary: leg.summary,
      };
    });

    // Sum calibrated leg durations to guarantee mathematical consistency across the timeline
    const durationSeconds =
      legs && legs.length > 0
        ? legs.reduce((acc, leg) => acc + leg.durationSeconds, 0)
        : Math.round(primaryRoute.duration * effectiveCalibration);
    const durationMinutes = Number((durationSeconds / 60).toFixed(1));

    const response: RouteResponse = {
      geometry: primaryRoute.geometry,
      distanceMeters,
      distanceMiles,
      durationSeconds,
      durationMinutes,
      waypoints,
      legs,
      cached: false,
    };

    // Save to cache
    this.cache.set(cacheKey, response);

    return response;
  }

  public getCalibrationFactor(): number {
    return this.calibrationFactor;
  }

  public getCache(): RouteCache {
    return this.cache;
  }
}

export const defaultRouteService = new RouteService();
