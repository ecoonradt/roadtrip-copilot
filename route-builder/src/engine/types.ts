import type { WaypointType, WaypointNotification } from '../types/routing';

/**
 * Input waypoint for timeline cascade calculation.
 */
export interface TimelineCascadeWaypoint {
  id: string;
  name: string;
  place_name?: string;
  type?: WaypointType;
  lat: number;
  lng: number;
  dwell_minutes: number;
  trigger_radius_miles?: number;
  notification?: WaypointNotification;
  timezone?: string; // Optional explicit IANA timezone (e.g. "America/Phoenix", "America/Denver")
  address?: string;
  google_place_id?: string;
  is_route_anchor?: boolean;
  approachHighway?: string;
  notes?: string;
}

/**
 * A scheduled stop computed by the timeline cascade engine.
 */
export interface ScheduledStop {
  id: string;
  name: string;
  place_name?: string;
  type: WaypointType;
  lat: number;
  lng: number;
  dwell_minutes: number;
  trigger_radius_miles: number;
  notification?: WaypointNotification;
  address?: string;
  google_place_id?: string;
  is_route_anchor?: boolean;
  approachHighway?: string;
  notes?: string;

  // Timezone metadata
  timezone: string; // IANA timezone identifier
  timezoneAbbreviation: string; // e.g. "MST" or "MDT"
  timezoneOffsetMinutes: number; // e.g. -420 for UTC-7, -360 for UTC-6
  timezoneOffsetStr: string; // e.g. "-07:00" or "-06:00"

  // Local timeline display strings (formatted in stop's local timezone)
  arrivalTime: string; // "14:30:00"
  arrivalShortTime: string; // "14:30"
  departureTime: string; // "14:30:00" (arrivalTime + dwell_minutes)
  departureShortTime: string; // "14:30"
  localDate: string; // "2026-10-09"

  // ISO 8601 strings with timezone offset
  arrivalIso: string; // "2026-10-09T14:30:00-07:00"
  departureIso: string; // "2026-10-09T14:30:00-07:00"

  // Unix epoch timestamps (ms) for exact arithmetic and comparison
  arrivalEpochMs: number;
  departureEpochMs: number;
  offsetMinutesFromStart?: number;

  // Segment metrics from preceding stop (0 for the initial stop)
  driveDurationFromPreviousSeconds: number;
  driveDistanceMilesFromPrevious: number;

  // Indicates if this stop crossed a timezone boundary from the preceding stop
  isTimezoneBoundaryCrossing: boolean;
  timezoneShiftHours?: number; // e.g. +1 when moving from AZ (UTC-7) to NM (UTC-6)
}

export type SchedulingMode = 'forward' | 'backward' | 'adhoc';

/**
 * Options and parameters provided to the forward timeline cascade engine.
 */
export interface TimelineCascadeInput {
  baseDate: string; // "YYYY-MM-DD" e.g. "2026-10-09"
  departureTime: string; // "HH:mm:ss" or "HH:mm" e.g. "14:30:00"
  defaultTimezone?: string; // Default fallback timezone (defaults to "America/Phoenix")
  waypoints: TimelineCascadeWaypoint[];
  driveDurationsSeconds?: number[]; // Pairwise driving durations between consecutive stops: [W0->W1, W1->W2, ...]
  driveDistancesMiles?: number[]; // Pairwise driving distances between consecutive stops
  isAdHoc?: boolean;
}

/**
 * Complete computed result of the forward timeline cascade.
 */
export interface TimelineCascadeResult {
  stops: ScheduledStop[];
  totalDriveSeconds: number;
  totalDriveMinutes: number;
  totalDwellMinutes: number;
  totalTripSeconds: number; // Total elapsed time from first departure to final arrival
  totalDistanceMiles: number;
  startTime: string; // Local departure time at stop 1
  endTime: string; // Local arrival time at final stop
  timezonesCrossed: string[]; // Unique list of timezones encountered along the route
  isAdHoc?: boolean;
}

/**
 * Input parameters for backward scheduling ("The Flight Catch-up").
 */
export interface BackwardScheduleInput {
  baseDate: string; // "YYYY-MM-DD" e.g. "2026-10-12"
  targetArrivalTime: string; // "HH:mm:ss" or "HH:mm" (hard arrival deadline at destination stop)
  destinationTimezone?: string; // Optional override for destination timezone
  defaultTimezone?: string; // Fallback timezone (defaults to "America/Phoenix")
  waypoints: TimelineCascadeWaypoint[];
  driveDurationsSeconds?: number[]; // Pairwise driving durations between consecutive stops
  driveDistancesMiles?: number[]; // Pairwise driving distances between consecutive stops
}

/**
 * Result of backward scheduling calculation.
 */
export interface BackwardScheduleResult {
  requiredDepartureTime: string; // "HH:mm:ss" required departure time in stop 1's local timezone
  originTimezone: string; // Stop 1 timezone
  targetArrivalTime: string; // Target arrival time at final stop
  destinationTimezone: string; // Final stop timezone
  cascadeResult: TimelineCascadeResult; // The forward cascade result starting from requiredDepartureTime
}

/**
 * Coordinate location for Google Maps Navigation URLs.
 */
export interface CoordinateLocation {
  lat: number;
  lng: number;
  name?: string;
  placeName?: string;
  address?: string;
  placeId?: string;
  type?: WaypointType;
  dwellMinutes?: number;
  isRouteAnchor?: boolean;
}

/**
 * A partitioned driving leg for Google Maps Navigation.
 */
export interface GoogleMapsLeg {
  legIndex: number; // 0-indexed
  legNumber: number; // 1-indexed
  title: string; // e.g. "Full Route", "Leg 1 (Morning)", "Leg 2 (Afternoon)"
  origin: CoordinateLocation;
  destination: CoordinateLocation;
  intermediateWaypoints: CoordinateLocation[];
  waypointCount: number; // Total points in this leg (origin + intermediate + destination)
  url: string; // Complete Google Maps navigation URL
}

/**
 * Result of Google Maps URL generation.
 */
export interface GoogleMapsRouteResult {
  legs: GoogleMapsLeg[];
  totalLegs: number;
  primaryUrl: string; // URL of the first leg or the single route
}

/**
 * Optional configuration for Google Maps URL generation.
 */
export interface GoogleMapsUrlOptions {
  customLegTitles?: string[];
  maxIntermediateWaypoints?: number; // Defaults to 9 (Google Maps limit)
  skipNavFiltering?: boolean;
}
