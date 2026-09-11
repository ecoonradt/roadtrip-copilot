export interface GeocodeResult {
  lat: number;
  lng: number;
  displayName: string;
  boundingBox?: [number, number, number, number];
}

export type WaypointType =
  | 'origin'
  | 'destination'
  | 'scenic_pull_off'
  | 'scenic_drive_by'
  | 'meal'
  | 'fuel'
  | 'lodging';

export interface WaypointNotification {
  title: string;
  message: string;
  speech: string;
}

export interface Waypoint {
  id: string;
  name: string;
  type: WaypointType;
  lat: number;
  lng: number;
  target_time?: string;
  dwell_minutes: number;
  trigger_radius_miles: number;
  notification?: WaypointNotification;
  timezone?: string;
  approachHighway?: string;
  notes?: string;
}


export interface RouteLeg {
  distanceMeters: number;
  distanceMiles: number;
  durationSeconds: number;
  durationMinutes: number;
  summary?: string;
}

export interface RouteGeometry {
  type: 'LineString';
  coordinates: [number, number][]; // [lon, lat]
}

export interface RouteResponse {
  geometry: RouteGeometry;
  distanceMeters: number;
  distanceMiles: number;
  durationSeconds: number;
  durationMinutes: number;
  waypoints?: Array<{ name: string; location: [number, number] }>;
  legs?: RouteLeg[];
  cached?: boolean;
}
