import type { Waypoint, WaypointType } from '../types/routing';
import type { ScheduledStop } from './types';

export interface ItineraryNotificationV2 {
  title: string;
  message: string;
  speech: string;
}

export interface CheckpointV2 {
  id: string;
  name: string;
  type?: WaypointType | string;
  lat: number;
  lng: number;
  target_time?: string;
  offset_minutes_from_start?: number;
  dwell_minutes?: number;
  trigger_radius_miles: number;
  notification?: ItineraryNotificationV2;
}

export interface DayV2 {
  day: number;
  date: string;
  timezone?: string;
  title?: string;
  origin?: string;
  destination?: string;
  departure_time?: string;
  checkpoints: CheckpointV2[];
}

export interface ItineraryDatesV2 {
  start: string;
  end: string;
}

export interface ItineraryMetadataV2 {
  version: string;
  author?: string;
  created_at: string;
  description?: string;
}

export interface MultiDayItineraryV2 {
  trip_name: string;
  dates?: ItineraryDatesV2;
  metadata: ItineraryMetadataV2;
  days: DayV2[];
}

export interface SingleRouteItineraryV2 {
  trip_name: string;
  date?: string;
  timezone?: string;
  metadata: ItineraryMetadataV2;
  origin?: string;
  destination?: string;
  checkpoints: CheckpointV2[];
}

export type ItineraryExportModel = MultiDayItineraryV2 | SingleRouteItineraryV2;

export interface FormatMultiDayOptions {
  tripName: string;
  startDate?: string;
  endDate?: string;
  author?: string;
  description?: string;
  days: Array<{
    dayNumber: number;
    date: string;
    timezone?: string;
    title?: string;
    origin?: string;
    destination?: string;
    departureTime?: string;
    waypoints?: Waypoint[];
    scheduledStops?: ScheduledStop[];
  }>;
}

export interface FormatSingleRouteOptions {
  tripName: string;
  date?: string;
  timezone?: string;
  author?: string;
  description?: string;
  origin?: string;
  destination?: string;
  waypoints?: Waypoint[];
  scheduledStops?: ScheduledStop[];
}

/**
 * Normalizes coordinate numbers to 6 decimal digits for clean JSON output.
 */
export function normalizeCoordinate(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * Clamps trigger radius to the standard 0.3 - 6.0 mile range.
 */
export function normalizeTriggerRadius(radius?: number): number {
  if (radius === undefined || radius === null || isNaN(radius)) {
    return 0.5;
  }
  const clamped = Math.max(0.3, Math.min(6.0, radius));
  return Number(clamped.toFixed(1));
}

/**
 * Converts a Waypoint or ScheduledStop into an official CheckpointV2 object.
 */
export function formatCheckpointV2(
  item: Waypoint | ScheduledStop,
  options?: {
    targetTime?: string;
    offsetMinutesFromStart?: number;
  }
): CheckpointV2 {
  const isScheduled = 'arrivalTime' in item;
  const targetTime =
    options?.targetTime ??
    (isScheduled ? item.arrivalTime : item.target_time ?? undefined);

  const checkpoint: CheckpointV2 = {
    id: item.id,
    name: item.name,
    type: item.type,
    lat: normalizeCoordinate(item.lat),
    lng: normalizeCoordinate(item.lng),
    dwell_minutes: Math.max(0, Math.round(item.dwell_minutes || 0)),
    trigger_radius_miles: normalizeTriggerRadius(item.trigger_radius_miles),
  };

  if (targetTime) {
    checkpoint.target_time = targetTime;
  }

  if (options?.offsetMinutesFromStart !== undefined) {
    checkpoint.offset_minutes_from_start = Math.max(0, Math.round(options.offsetMinutesFromStart));
  }

  if (item.notification && (item.notification.title || item.notification.message || item.notification.speech)) {
    checkpoint.notification = {
      title: item.notification.title || item.name,
      message: item.notification.message || '',
      speech: item.notification.speech || '',
    };
  }

  return checkpoint;
}

/**
 * Formats multi-day road trip data into an official V2 Itinerary schema object.
 */
export function formatMultiDayItinerary(options: FormatMultiDayOptions): MultiDayItineraryV2 {
  const days: DayV2[] = options.days.map((dayInput) => {
    let checkpoints: CheckpointV2[] = [];

    if (dayInput.scheduledStops && dayInput.scheduledStops.length > 0) {
      checkpoints = dayInput.scheduledStops.map((stop) => formatCheckpointV2(stop));
    } else if (dayInput.waypoints && dayInput.waypoints.length > 0) {
      checkpoints = dayInput.waypoints.map((wp) => formatCheckpointV2(wp));
    }

    const firstStopName = checkpoints[0]?.name;
    const lastStopName = checkpoints[checkpoints.length - 1]?.name;

    const dayObj: DayV2 = {
      day: dayInput.dayNumber,
      date: dayInput.date,
      timezone: dayInput.timezone || 'America/Phoenix',
      title: dayInput.title || `Day ${dayInput.dayNumber}: ${firstStopName || 'Start'} to ${lastStopName || 'End'}`,
      origin: dayInput.origin || firstStopName || 'Origin',
      destination: dayInput.destination || lastStopName || 'Destination',
      departure_time: dayInput.departureTime || checkpoints[0]?.target_time || '08:00:00',
      checkpoints,
    };

    return dayObj;
  });

  const startDate = options.startDate || days[0]?.date || new Date().toISOString().split('T')[0];
  const endDate = options.endDate || days[days.length - 1]?.date || startDate;

  return {
    trip_name: options.tripName,
    dates: {
      start: startDate,
      end: endDate,
    },
    metadata: {
      version: '2.0.0',
      author: options.author || 'Roadtrip Co-Pilot Route Builder',
      created_at: new Date().toISOString(),
      ...(options.description ? { description: options.description } : {}),
    },
    days,
  };
}

/**
 * Formats a single-day or ad-hoc test run route into a single-route V2 itinerary.
 */
export function formatSingleRouteItinerary(options: FormatSingleRouteOptions): SingleRouteItineraryV2 {
  let checkpoints: CheckpointV2[] = [];

  if (options.scheduledStops && options.scheduledStops.length > 0) {
    const startEpochMs = options.scheduledStops[0].arrivalEpochMs;
    checkpoints = options.scheduledStops.map((stop) => {
      const offsetMinutes = Math.max(0, Math.round((stop.arrivalEpochMs - startEpochMs) / 60000));
      return formatCheckpointV2(stop, { offsetMinutesFromStart: offsetMinutes });
    });
  } else if (options.waypoints && options.waypoints.length > 0) {
    checkpoints = options.waypoints.map((wp, idx) => {
      // If waypoint doesn't have an explicit offset, estimate 15 minutes per segment
      const offset = idx * 15;
      return formatCheckpointV2(wp, { offsetMinutesFromStart: offset });
    });
  }

  const firstStopName = checkpoints[0]?.name;
  const lastStopName = checkpoints[checkpoints.length - 1]?.name;

  return {
    trip_name: options.tripName,
    date: options.date || new Date().toISOString().split('T')[0],
    timezone: options.timezone || 'America/Phoenix',
    metadata: {
      version: '2.0.0',
      author: options.author || 'Roadtrip Co-Pilot Route Builder',
      created_at: new Date().toISOString(),
      ...(options.description ? { description: options.description } : {}),
    },
    origin: options.origin || firstStopName || 'Origin',
    destination: options.destination || lastStopName || 'Destination',
    checkpoints,
  };
}

/**
 * Serializes an Itinerary V2 object into a formatted JSON string.
 */
export function exportItineraryToJson(
  itinerary: ItineraryExportModel,
  indent = 2
): string {
  return JSON.stringify(itinerary, null, indent);
}

/**
 * Triggers a browser file download of the JSON itinerary.
 */
export function downloadItineraryJson(
  itinerary: ItineraryExportModel | string,
  fileName = 'itinerary.json'
): void {
  const jsonString = typeof itinerary === 'string' ? itinerary : exportItineraryToJson(itinerary);
  const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName.endsWith('.json') ? fileName : `${fileName}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
