import type { Waypoint, WaypointType } from '../types/routing';
import { detectTimezone, calculateTimelineCascade, parseLocalToUtcEpoch, DEFAULT_TIMEZONE } from './cascade';
import type { ScheduledStop, CoordinateLocation, SchedulingMode } from './types';
import { generateGoogleMapsUrls } from './googleMapsUrl';

export interface ParsedDay {
  dayNumber: number;
  date: string;
  title: string;
  departureTime: string;
  timezone?: string;
  waypoints: Waypoint[];
  origin?: string;
  destination?: string;
  notes?: string;
  isAdHoc?: boolean;
  google_maps_url?: string;
  schedulingMode?: SchedulingMode;
  targetArrivalTime?: string;
}

export interface ParsedTrip {
  fileName?: string;
  tripName: string;
  isMultiDay: boolean;
  dates?: { start: string; end: string };
  google_maps_url?: string;
  days: ParsedDay[];
  isAdHoc?: boolean;
  etag?: string;
}

function parseSchedulingMode(value: unknown): SchedulingMode | undefined {
  return value === 'forward' || value === 'backward' || value === 'adhoc' ? value : undefined;
}

export function getDaySchedulingMode(day: ParsedDay, tripIsAdHoc = false): SchedulingMode {
  return day.schedulingMode ?? ((day.isAdHoc ?? tripIsAdHoc) ? 'adhoc' : 'forward');
}

/**
 * Infers a sensible WaypointType if not explicitly provided in the raw data.
 */
export function inferWaypointType(name: string, id: string, index: number, total: number): WaypointType {
  const lower = `${name} ${id}`.toLowerCase();

  if (index === 0) return 'origin';
  if (lower.includes('rental') || lower.includes('airport') || lower.includes('depart')) {
    if (index === 0) return 'origin';
  }
  if (lower.includes('hotel') || lower.includes('inn') || lower.includes('motel') || lower.includes('lodge') || lower.includes('resort')) {
    return 'lodging';
  }
  if (lower.includes('dining') || lower.includes('brew') || lower.includes('cafe') || lower.includes('restaurant') || lower.includes('taco') || lower.includes('burger') || lower.includes('food')) {
    return 'meal';
  }
  if (lower.includes('fuel') || lower.includes('gas') || lower.includes('chevron') || lower.includes('shell') || lower.includes('charge')) {
    return 'fuel';
  }
  if (
    lower.includes('grocery') ||
    lower.includes('safeway') ||
    lower.includes('trader joe') ||
    lower.includes('walmart') ||
    lower.includes('target') ||
    lower.includes('supermarket') ||
    lower.includes('costco') ||
    lower.includes('market') ||
    lower.includes('pharmacy') ||
    lower.includes('walgreens') ||
    lower.includes('cvs') ||
    lower.includes('errand') ||
    lower.includes('store')
  ) {
    return 'stop';
  }
  if (lower.includes('scenic') || lower.includes('vista') || lower.includes('pull-off') || lower.includes('overlook') || lower.includes('canyon') || lower.includes('monument') || lower.includes('pass')) {
    return 'scenic_pull_off';
  }
  if (index === total - 1) {
    return 'destination';
  }
  return 'scenic_pull_off';
}

/**
 * Parses raw JSON (both V1 schema like itinerary.json and V2 schema) into a unified ParsedTrip.
 */
export function parseItineraryJson(raw: unknown, fileName?: string): ParsedTrip {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid itinerary: expected a JSON object');
  }

  const data = raw as Record<string, unknown>;

  const tripName =
    typeof data.trip_name === 'string'
      ? data.trip_name
      : typeof data.title === 'string'
      ? data.title
      : fileName?.replace(/\.json$/, '') || 'Untitled Road Trip';

  const daysRaw = Array.isArray(data.days) ? (data.days as Record<string, unknown>[]) : [];
  const isMultiDay = daysRaw.length > 0;

  const parsedDays: ParsedDay[] = [];

  if (isMultiDay) {
    for (let i = 0; i < daysRaw.length; i++) {
      const d = daysRaw[i];
      const dayNum = typeof d.day === 'number' ? d.day : i + 1;
      const date = typeof d.date === 'string' ? d.date : new Date().toISOString().slice(0, 10);
      const title = typeof d.title === 'string' ? d.title : `Day ${dayNum}`;
      const rawCheckpoints = Array.isArray(d.checkpoints) ? (d.checkpoints as Record<string, unknown>[]) : [];
      const firstCp = rawCheckpoints[0];
      const inferredTz = firstCp && typeof firstCp.lat === 'number' && typeof firstCp.lng === 'number'
        ? detectTimezone(firstCp.lat, firstCp.lng)
        : undefined;
      const tz = typeof d.timezone === 'string' && d.timezone.trim() ? d.timezone.trim() : inferredTz || DEFAULT_TIMEZONE;

      const waypoints = rawCheckpoints.map((cp, idx) =>
        convertRawCheckpointToWaypoint(cp, idx, rawCheckpoints.length, tz)
      );
      const schedulingMode = parseSchedulingMode(d.scheduling_mode ?? d.schedulingMode);
      const isAdHocDay = schedulingMode === 'adhoc' || (schedulingMode === undefined &&
        rawCheckpoints.some((cp) => typeof cp.offset_minutes_from_start === 'number') &&
        !rawCheckpoints.some((cp) => typeof cp.target_time === 'string' && cp.target_time.trim()));

      // Determine departure time: first checkpoint target_time or default 09:00:00
      let departureTime = '09:00:00';
      if (typeof d.departure_time === 'string' && d.departure_time.trim()) {
        departureTime = normalizeTimeString(d.departure_time);
      } else if (waypoints.length > 0 && waypoints[0].target_time) {
        departureTime = normalizeTimeString(waypoints[0].target_time);
      }

      parsedDays.push({
        dayNumber: dayNum,
        date,
        title,
        departureTime,
        timezone: tz,
        waypoints,
        origin: typeof d.origin === 'string' ? d.origin : undefined,
        destination: typeof d.destination === 'string' ? d.destination : undefined,
        google_maps_url: typeof d.google_maps_url === 'string' ? d.google_maps_url : undefined,
        isAdHoc: isAdHocDay,
        schedulingMode,
        targetArrivalTime: typeof d.target_arrival_time === 'string' ? d.target_arrival_time : typeof d.targetArrivalTime === 'string' ? d.targetArrivalTime : undefined,
      });
    }
  } else {
    // Single Day / Ad-hoc route
    const rawCheckpoints = Array.isArray(data.checkpoints)
      ? (data.checkpoints as Record<string, unknown>[])
      : [];
    const firstCp = rawCheckpoints[0];
    const inferredTz = firstCp && typeof firstCp.lat === 'number' && typeof firstCp.lng === 'number'
      ? detectTimezone(firstCp.lat, firstCp.lng)
      : undefined;
    const tz = typeof data.timezone === 'string' && data.timezone.trim() ? data.timezone.trim() : inferredTz || DEFAULT_TIMEZONE;
    const date = typeof data.date === 'string' ? data.date : new Date().toISOString().slice(0, 10);

    const waypoints = rawCheckpoints.map((cp, idx) =>
      convertRawCheckpointToWaypoint(cp, idx, rawCheckpoints.length, tz)
    );

    let departureTime = '09:00:00';
    if (typeof data.departure_time === 'string' && data.departure_time.trim()) {
      departureTime = normalizeTimeString(data.departure_time);
    } else if (waypoints.length > 0 && waypoints[0].target_time) {
      departureTime = normalizeTimeString(waypoints[0].target_time);
    }

    const originName =
      typeof data.origin === 'string'
        ? data.origin
        : data.origin && typeof (data.origin as Record<string, unknown>).address === 'string'
        ? ((data.origin as Record<string, unknown>).address as string)
        : undefined;

    const destinationName =
      typeof data.destination === 'string'
        ? data.destination
        : data.destination && typeof (data.destination as Record<string, unknown>).address === 'string'
        ? ((data.destination as Record<string, unknown>).address as string)
        : undefined;

    const hasExplicitDate = typeof data.date === 'string' && data.date.trim().length > 0;
    const hasAdHocOffsets = rawCheckpoints.some((cp) => typeof cp.offset_minutes_from_start === 'number');
    const storedMode = parseSchedulingMode(data.scheduling_mode ?? data.schedulingMode);
    const isAdHocDay = storedMode ? storedMode === 'adhoc' : Boolean(!hasExplicitDate || (hasAdHocOffsets && !rawCheckpoints.some((cp) => typeof cp.target_time === 'string' && cp.target_time.trim())));

    parsedDays.push({
      dayNumber: 1,
      date,
      title: tripName,
      departureTime,
      timezone: tz,
      waypoints,
      origin: originName,
      destination: destinationName,
      isAdHoc: isAdHocDay,
      google_maps_url: typeof data.google_maps_url === 'string' ? data.google_maps_url : undefined,
      schedulingMode: storedMode ?? (isAdHocDay ? 'adhoc' : undefined),
      targetArrivalTime: typeof data.target_arrival_time === 'string' ? data.target_arrival_time : typeof data.targetArrivalTime === 'string' ? data.targetArrivalTime : undefined,
    });
  }

  const isTripAdHoc = !isMultiDay && Boolean(parsedDays[0]?.isAdHoc);

  let dates: { start: string; end: string } | undefined;
  if (data.dates && typeof data.dates === 'object') {
    const dObj = data.dates as Record<string, unknown>;
    if (typeof dObj.start === 'string' && typeof dObj.end === 'string') {
      dates = { start: dObj.start, end: dObj.end };
    }
  } else if (parsedDays.length > 0 && !isTripAdHoc) {
    dates = {
      start: parsedDays[0].date,
      end: parsedDays[parsedDays.length - 1].date,
    };
  }

  return {
    fileName,
    tripName,
    isMultiDay,
    dates,
    google_maps_url: typeof data.google_maps_url === 'string' ? data.google_maps_url : parsedDays[0]?.google_maps_url,
    days: parsedDays,
    isAdHoc: isTripAdHoc,
    etag: typeof data._etag === 'string' ? data._etag : undefined,
  };
}

/**
 * Converts a raw checkpoint dictionary into a strict Waypoint object.
 */
function convertRawCheckpointToWaypoint(
  cp: Record<string, unknown>,
  idx: number,
  total: number,
  defaultTz: string
): Waypoint {
  const id = typeof cp.id === 'string' ? cp.id : `wp_${idx + 1}_${Date.now()}`;
  const name = typeof cp.name === 'string' ? cp.name : `Stop ${idx + 1}`;
  const lat = typeof cp.lat === 'number' ? cp.lat : parseFloat(String(cp.lat || 0));
  const lng = typeof cp.lng === 'number' ? cp.lng : parseFloat(String(cp.lng || 0));

  const validTypes: WaypointType[] = [
    'origin',
    'destination',
    'scenic_pull_off',
    'scenic_drive_by',
    'meal',
    'fuel',
    'lodging',
    'stop',
  ];

  const normalizedInputType = cp.type === 'general_stop' ? 'stop' : cp.type;
  const rawType = typeof normalizedInputType === 'string' ? (normalizedInputType as WaypointType) : undefined;
  const type: WaypointType = rawType && validTypes.includes(rawType)
    ? rawType
    : inferWaypointType(name, id, idx, total);

  const target_time =
    typeof cp.target_time === 'string' && cp.target_time.trim()
      ? normalizeTimeString(cp.target_time)
      : undefined;

  const isFinalStop = idx === total - 1;
  const isOvernightOrFinalDest = isFinalStop && (type === 'lodging' || type === 'destination');

  const dwell_minutes =
    isOvernightOrFinalDest
      ? 0
      : typeof cp.dwell_minutes === 'number'
      ? cp.dwell_minutes
      : idx === 0 || type === 'scenic_drive_by' || cp.is_route_anchor
      ? 0
      : type === 'lodging'
      ? 0
      : 20;

  const trigger_radius_miles =
    typeof cp.trigger_radius_miles === 'number'
      ? cp.trigger_radius_miles
      : 2.0;

  let notification: Waypoint['notification'] = undefined;
  if (type !== 'stop' && cp.notification && typeof cp.notification === 'object') {
    const n = cp.notification as Record<string, unknown>;
    if (typeof n.title === 'string' && typeof n.speech === 'string') {
      notification = {
        title: n.title,
        message: typeof n.message === 'string' ? n.message : '',
        speech: n.speech,
      };
    }
  }

  return {
    id,
    name,
    type,
    lat,
    lng,
    target_time,
    offset_minutes_from_start: typeof cp.offset_minutes_from_start === 'number' ? cp.offset_minutes_from_start : undefined,
    dwell_minutes,
    trigger_radius_miles,
    notification,
    timezone:
      typeof cp.timezone === 'string' && cp.timezone.trim()
        ? cp.timezone
        : lat && lng
        ? detectTimezone(lat, lng, defaultTz)
        : defaultTz,
    approachHighway: typeof cp.approachHighway === 'string' ? cp.approachHighway : undefined,
    notes: typeof cp.notes === 'string' ? cp.notes : undefined,
    place_name: typeof cp.place_name === 'string' ? cp.place_name : undefined,
    address: typeof cp.address === 'string' ? cp.address : undefined,
    google_place_id: typeof cp.google_place_id === 'string' ? cp.google_place_id : undefined,
    is_route_anchor: type === 'stop' ? false : (typeof cp.is_route_anchor === 'boolean' ? cp.is_route_anchor : undefined),
  };
}

function normalizeTimeString(timeStr: string): string {
  const parts = timeStr.trim().split(':');
  if (parts.length === 2) {
    return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}:00`;
  }
  if (parts.length >= 3) {
    return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}:${parts[2].padStart(2, '0')}`;
  }
  return timeStr;
}

function serializeCheckpoint(w: Waypoint, idx?: number, total?: number, isAdHoc?: boolean): Record<string, unknown> {
  const isLast = total !== undefined && idx !== undefined ? idx === total - 1 : false;
  const isOvernightOrFinalDest = isLast && (w.type === 'lodging' || w.type === 'destination');
  const dwellMinutes = isOvernightOrFinalDest ? 0 : Math.max(0, Math.round(w.dwell_minutes || 0));

  const cp: Record<string, unknown> = {
    id: w.id,
    name: w.name,
    type: w.type,
    lat: Number(w.lat.toFixed(6)),
    lng: Number(w.lng.toFixed(6)),
    dwell_minutes: dwellMinutes,
    trigger_radius_miles: w.trigger_radius_miles ?? 2.0,
  };

  if (w.target_time && !isAdHoc) {
    cp.target_time = w.target_time;
  }

  if (w.offset_minutes_from_start !== undefined) {
    cp.offset_minutes_from_start = Math.max(0, Math.round(w.offset_minutes_from_start));
  }

  if (w.notification && (w.notification.title || w.notification.message || w.notification.speech)) {
    cp.notification = {
      title: w.notification.title,
      message: w.notification.message,
      speech: w.notification.speech,
    };
  }

  if (w.place_name) {
    cp.place_name = w.place_name;
  }

  if (w.address) {
    cp.address = w.address;
  }

  if (w.google_place_id) {
    cp.google_place_id = w.google_place_id;
  }

  if (w.is_route_anchor !== undefined) {
    // Physical stops, endpoints, and lodging/dining/fuel stops are never route anchors
    const isEndpointOrPhysical =
      w.type === 'origin' ||
      w.type === 'destination' ||
      w.type === 'lodging' ||
      w.type === 'meal' ||
      w.type === 'fuel' ||
      (typeof w.dwell_minutes === 'number' && w.dwell_minutes > 0) ||
      (idx === 0 && w.type !== 'scenic_drive_by');

    cp.is_route_anchor = isEndpointOrPhysical ? false : w.is_route_anchor;
  }

  if (w.approachHighway) {
    cp.approachHighway = w.approachHighway;
  }

  if (w.notes) {
    cp.notes = w.notes;
  }

  if (w.timezone) {
    cp.timezone = w.timezone;
  }

  return cp;
}

export interface SerializeOptions {
  isAdHoc?: boolean;
  preserveTargetTimes?: boolean;
}

function isTargetBeforeDeparture(
  targetTime: string,
  targetTimezone: string | undefined,
  departureTime: string,
  departureTimezone: string | undefined,
  baseDate: string | undefined
): boolean {
  if (!baseDate) {
    return targetTime < departureTime;
  }
  const tzA = targetTimezone || departureTimezone || DEFAULT_TIMEZONE;
  const tzB = departureTimezone || targetTimezone || DEFAULT_TIMEZONE;
  try {
    const epochTarget = parseLocalToUtcEpoch(baseDate, targetTime, tzA);
    const epochDep = parseLocalToUtcEpoch(baseDate, departureTime, tzB);
    return epochTarget < epochDep;
  } catch {
    return targetTime < departureTime;
  }
}

function resolveCheckpointTargetTime(
  w: Waypoint,
  cascadedTarget: string | undefined,
  departureTime: string | undefined,
  dayTimezone: string | undefined,
  baseDate: string | undefined,
  isAdHoc: boolean,
  preserveTargetTimes?: boolean
): string | undefined {
  if (isAdHoc) return undefined;
  if (preserveTargetTimes) return w.target_time;
  if (!w.target_time) return cascadedTarget;
  // If target time is chronologically before departure time (e.g. legacy draft error), re-synchronize
  if (departureTime && isTargetBeforeDeparture(w.target_time, w.timezone, departureTime, dayTimezone, baseDate)) {
    return cascadedTarget || w.target_time;
  }
  return w.target_time;
}

/**
 * Serializes an in-memory ParsedTrip back into standard Android-compatible JSON.
 * Synchronizes target times with the dynamic schedule cascade to eliminate stale draft times.
 */
export function serializeTripToItineraryJson(trip: ParsedTrip, options?: SerializeOptions): Record<string, unknown> {
  const isAdHoc = Boolean(options?.isAdHoc ?? (trip.isMultiDay || !trip.days[0]
    ? trip.isAdHoc
    : getDaySchedulingMode(trip.days[0], trip.isAdHoc) === 'adhoc'));
  const preserveTargetTimes = Boolean(options?.preserveTargetTimes);

  if (trip.isMultiDay) {
    const days = trip.days.map((day) => {
      const dayIsAdHoc = getDaySchedulingMode(day, isAdHoc) === 'adhoc';
      let cascadedStops: ScheduledStop[] = [];
      try {
        if (day.waypoints && day.waypoints.length > 0) {
          const cascade = calculateTimelineCascade({
            baseDate: day.date,
            departureTime: day.departureTime || '09:00:00',
            waypoints: day.waypoints,
          });
          cascadedStops = cascade.stops;
        }
      } catch {
        // fallback
      }

      const navLocations: CoordinateLocation[] = day.waypoints.map((w) => ({
        lat: w.lat,
        lng: w.lng,
        name: w.name,
        placeName: w.place_name,
        address: w.address,
        placeId: w.google_place_id,
        type: w.type,
        dwellMinutes: w.dwell_minutes,
        isRouteAnchor: w.is_route_anchor,
      }));
      const gmapsResult = generateGoogleMapsUrls(navLocations);
      const dayGoogleMapsUrl = gmapsResult.primaryUrl || undefined;

      return {
        day: day.dayNumber,
        date: day.date,
        timezone: day.timezone || DEFAULT_TIMEZONE,
        title: day.title,
        origin: day.origin,
        destination: day.destination,
        departure_time: day.departureTime,
        ...(day.schedulingMode ? { scheduling_mode: day.schedulingMode } : {}),
        ...(day.targetArrivalTime ? { target_arrival_time: day.targetArrivalTime } : {}),
        ...(dayGoogleMapsUrl ? { google_maps_url: dayGoogleMapsUrl } : {}),
        ...(day.notes ? { notes: day.notes } : {}),
        checkpoints: day.waypoints.map((w, idx) => {
          const cascadedStop = cascadedStops[idx];
          const cascadedTarget = cascadedStop?.arrivalTime;
          const offsetMin = preserveTargetTimes
            ? w.offset_minutes_from_start
            : (w.offset_minutes_from_start ?? cascadedStop?.offsetMinutesFromStart ?? (idx * 15));
          const targetTime = resolveCheckpointTargetTime(
            w,
            cascadedTarget,
            day.departureTime,
            day.timezone,
            day.date,
            dayIsAdHoc,
            preserveTargetTimes
          );
          const updatedWp: Waypoint = {
            ...w,
            target_time: targetTime,
            offset_minutes_from_start: offsetMin,
          };
          return serializeCheckpoint(updatedWp, idx, day.waypoints.length, dayIsAdHoc);
        }),
      };
    });

    return {
      trip_name: trip.tripName,
      dates: trip.dates || {
        start: trip.days[0]?.date || '',
        end: trip.days[trip.days.length - 1]?.date || '',
      },
      ...(days[0]?.google_maps_url ? { google_maps_url: days[0].google_maps_url } : {}),
      metadata: {
        version: '2.0.0',
        author: 'Roadtrip Co-Pilot Studio',
        created_at: new Date().toISOString(),
      },
      days,
    };
  }

  // Single Day
  const singleDay = trip.days[0] || {
    date: new Date().toISOString().slice(0, 10),
    departureTime: '09:00:00',
    timezone: DEFAULT_TIMEZONE,
    waypoints: [],
  };

  let cascadedStops: ScheduledStop[] = [];
  try {
    if (singleDay.waypoints && singleDay.waypoints.length > 0) {
      const cascade = calculateTimelineCascade({
        baseDate: singleDay.date,
        departureTime: singleDay.departureTime || '09:00:00',
        waypoints: singleDay.waypoints,
        isAdHoc,
      });
      cascadedStops = cascade.stops;
    }
  } catch {
    // fallback
  }

  const navLocations: CoordinateLocation[] = singleDay.waypoints.map((w) => ({
    lat: w.lat,
    lng: w.lng,
    name: w.name,
    placeName: w.place_name,
    address: w.address,
    placeId: w.google_place_id,
    type: w.type,
    dwellMinutes: w.dwell_minutes,
    isRouteAnchor: w.is_route_anchor,
  }));
  const gmapsResult = generateGoogleMapsUrls(navLocations);
  const singleGoogleMapsUrl = gmapsResult.primaryUrl || undefined;

  const result: Record<string, unknown> = {
    trip_name: trip.tripName,
    timezone: singleDay.timezone || DEFAULT_TIMEZONE,
    departure_time: singleDay.departureTime,
    ...(singleDay.schedulingMode ? { scheduling_mode: singleDay.schedulingMode } : {}),
    ...(singleDay.targetArrivalTime ? { target_arrival_time: singleDay.targetArrivalTime } : {}),
    ...(singleGoogleMapsUrl ? { google_maps_url: singleGoogleMapsUrl } : {}),
    metadata: {
      version: '2.0.0',
      author: 'Roadtrip Co-Pilot Studio',
      created_at: new Date().toISOString(),
    },
    origin: singleDay.origin,
    destination: singleDay.destination,
    checkpoints: singleDay.waypoints.map((w, idx) => {
      const cascadedStop = cascadedStops[idx];
      const cascadedTarget = cascadedStop?.arrivalTime;
      const offsetMin = preserveTargetTimes
        ? w.offset_minutes_from_start
        : (w.offset_minutes_from_start ?? cascadedStop?.offsetMinutesFromStart ?? (idx * 15));
      const targetTime = resolveCheckpointTargetTime(
        w,
        cascadedTarget,
        singleDay.departureTime,
        singleDay.timezone,
        singleDay.date,
        isAdHoc,
        preserveTargetTimes
      );
      const updatedWp: Waypoint = {
        ...w,
        target_time: targetTime,
        offset_minutes_from_start: offsetMin,
      };
      return serializeCheckpoint(updatedWp, idx, singleDay.waypoints.length, isAdHoc);
    }),
  };

  if (!isAdHoc) {
    result.date = singleDay.date;
  }

  return result;
}
