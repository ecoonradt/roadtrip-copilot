import type { OsrmRawResponse, RouteResponse } from '../types/index.js';
import { RouteCache, defaultRouteCache } from './routeCache.js';

export const OSRM_BASE_URL = 'https://router.project-osrm.org/route/v1/driving';

export interface CoordinatePair {
  lon: number;
  lat: number;
}

export class RouteService {
  private readonly baseUrl: string;
  private readonly cache: RouteCache;

  constructor(baseUrl = OSRM_BASE_URL, cache = defaultRouteCache) {
    this.baseUrl = baseUrl;
    this.cache = cache;
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

  public async getRoute(coordsStr: string): Promise<RouteResponse> {
    const validPairs = this.parseAndValidateCoordinates(coordsStr);

    // Format coordinates as OSRM expects: {lon},{lat};{lon},{lat}...
    const formattedCoords = validPairs.map((p) => `${p.lon},${p.lat}`).join(';');

    // Check cache first
    const cached = this.cache.get(formattedCoords);
    if (cached) {
      return cached;
    }

    const url = `${this.baseUrl}/${formattedCoords}?overview=full&geometries=geojson`;

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
    const durationSeconds = Math.round(primaryRoute.duration);
    const durationMinutes = Number((durationSeconds / 60).toFixed(1));

    const waypoints = data.waypoints?.map((wp) => ({
      name: wp.name,
      location: wp.location,
    }));

    const response: RouteResponse = {
      geometry: primaryRoute.geometry,
      distanceMeters,
      distanceMiles,
      durationSeconds,
      durationMinutes,
      waypoints,
      cached: false,
    };

    // Save to cache
    this.cache.set(formattedCoords, response);

    return response;
  }

  public getCache(): RouteCache {
    return this.cache;
  }
}

export const defaultRouteService = new RouteService();
