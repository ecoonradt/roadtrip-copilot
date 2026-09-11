export interface GeocodeResult {
  lat: number;
  lng: number;
  displayName: string;
  boundingBox?: [number, number, number, number]; // [south, north, west, east]
}

export interface NominatimRawResult {
  place_id?: number;
  licence?: string;
  osm_type?: string;
  osm_id?: number;
  boundingbox?: string[];
  lat: string;
  lon: string;
  display_name: string;
  class?: string;
  type?: string;
  importance?: number;
}

export interface RouteGeometry {
  type: 'LineString';
  coordinates: [number, number][]; // Array of [lon, lat]
}

export interface RouteWaypoint {
  name: string;
  location: [number, number]; // [lon, lat]
}

export interface RouteLeg {
  distanceMeters: number;
  distanceMiles: number;
  durationSeconds: number;
  durationMinutes: number;
  summary?: string;
}

export interface RouteResponse {
  geometry: RouteGeometry;
  distanceMeters: number;
  distanceMiles: number;
  durationSeconds: number;
  durationMinutes: number;
  waypoints?: RouteWaypoint[];
  legs?: RouteLeg[];
  cached?: boolean;
}

export interface OsrmRawRoute {
  geometry: RouteGeometry;
  distance: number; // in meters
  duration: number; // in seconds
  weight?: number;
  weight_name?: string;
  legs?: Array<{
    distance: number;
    duration: number;
    summary?: string;
  }>;
}

export interface OsrmRawWaypoint {
  name: string;
  location: [number, number];
  distance?: number;
  hint?: string;
}

export interface OsrmRawResponse {
  code: string;
  message?: string;
  routes?: OsrmRawRoute[];
  waypoints?: OsrmRawWaypoint[];
}

export * from './ai.js';
export * from './device.js';

