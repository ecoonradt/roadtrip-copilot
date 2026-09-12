import type { Waypoint, WaypointType } from '../types/routing';

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
}

export interface ParsedTrip {
  fileName?: string;
  tripName: string;
  isMultiDay: boolean;
  dates?: { start: string; end: string };
  days: ParsedDay[];
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
      const tz = typeof d.timezone === 'string' ? d.timezone : 'America/Phoenix';
      const rawCheckpoints = Array.isArray(d.checkpoints) ? (d.checkpoints as Record<string, unknown>[]) : [];

      const waypoints = rawCheckpoints.map((cp, idx) =>
        convertRawCheckpointToWaypoint(cp, idx, rawCheckpoints.length, tz)
      );

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
      });
    }
  } else {
    // Single Day / Ad-hoc route
    const rawCheckpoints = Array.isArray(data.checkpoints)
      ? (data.checkpoints as Record<string, unknown>[])
      : [];
    const tz = typeof data.timezone === 'string' ? data.timezone : 'America/Phoenix';
    const date = typeof data.date === 'string' ? data.date : new Date().toISOString().slice(0, 10);

    const waypoints = rawCheckpoints.map((cp, idx) =>
      convertRawCheckpointToWaypoint(cp, idx, rawCheckpoints.length, tz)
    );

    let departureTime = '09:00:00';
    if (waypoints.length > 0 && waypoints[0].target_time) {
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

    parsedDays.push({
      dayNumber: 1,
      date,
      title: tripName,
      departureTime,
      timezone: tz,
      waypoints,
      origin: originName,
      destination: destinationName,
    });
  }

  let dates: { start: string; end: string } | undefined;
  if (data.dates && typeof data.dates === 'object') {
    const dObj = data.dates as Record<string, unknown>;
    if (typeof dObj.start === 'string' && typeof dObj.end === 'string') {
      dates = { start: dObj.start, end: dObj.end };
    }
  } else if (parsedDays.length > 0) {
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
    days: parsedDays,
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
  ];

  const rawType = typeof cp.type === 'string' ? (cp.type as WaypointType) : undefined;
  const type: WaypointType = rawType && validTypes.includes(rawType)
    ? rawType
    : inferWaypointType(name, id, idx, total);

  const target_time =
    typeof cp.target_time === 'string' && cp.target_time.trim()
      ? normalizeTimeString(cp.target_time)
      : undefined;

  const dwell_minutes =
    typeof cp.dwell_minutes === 'number'
      ? cp.dwell_minutes
      : idx === 0
      ? 0
      : type === 'lodging'
      ? 0
      : 20;

  const trigger_radius_miles =
    typeof cp.trigger_radius_miles === 'number'
      ? cp.trigger_radius_miles
      : 2.0;

  let notification: Waypoint['notification'] = undefined;
  if (cp.notification && typeof cp.notification === 'object') {
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
    dwell_minutes,
    trigger_radius_miles,
    notification,
    timezone: typeof cp.timezone === 'string' ? cp.timezone : defaultTz,
    approachHighway: typeof cp.approachHighway === 'string' ? cp.approachHighway : undefined,
    notes: typeof cp.notes === 'string' ? cp.notes : undefined,
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

/**
 * Serializes an in-memory ParsedTrip back into standard Android-compatible JSON.
 */
export function serializeTripToItineraryJson(trip: ParsedTrip): Record<string, unknown> {
  if (trip.isMultiDay) {
    return {
      trip_name: trip.tripName,
      dates: trip.dates || {
        start: trip.days[0]?.date || '',
        end: trip.days[trip.days.length - 1]?.date || '',
      },
      metadata: {
        version: '2.0.0',
        author: 'Roadtrip Co-Pilot Studio',
        created_at: new Date().toISOString(),
      },
      days: trip.days.map((day) => ({
        day: day.dayNumber,
        date: day.date,
        timezone: day.timezone || 'America/Phoenix',
        title: day.title,
        origin: day.origin,
        destination: day.destination,
        departure_time: day.departureTime,
        checkpoints: day.waypoints.map((w) => ({
          id: w.id,
          name: w.name,
          type: w.type,
          lat: Number(w.lat.toFixed(6)),
          lng: Number(w.lng.toFixed(6)),
          target_time: w.target_time,
          dwell_minutes: w.dwell_minutes,
          trigger_radius_miles: w.trigger_radius_miles,
          notification: w.notification
            ? {
                title: w.notification.title,
                message: w.notification.message,
                speech: w.notification.speech,
              }
            : undefined,
        })),
      })),
    };
  }

  // Single Day
  const singleDay = trip.days[0] || {
    date: new Date().toISOString().slice(0, 10),
    departureTime: '09:00:00',
    timezone: 'America/Phoenix',
    waypoints: [],
  };

  return {
    trip_name: trip.tripName,
    date: singleDay.date,
    timezone: singleDay.timezone || 'America/Phoenix',
    metadata: {
      version: '2.0.0',
      author: 'Roadtrip Co-Pilot Studio',
      created_at: new Date().toISOString(),
    },
    origin: singleDay.origin,
    destination: singleDay.destination,
    checkpoints: singleDay.waypoints.map((w) => ({
      id: w.id,
      name: w.name,
      type: w.type,
      lat: Number(w.lat.toFixed(6)),
      lng: Number(w.lng.toFixed(6)),
      target_time: w.target_time,
      dwell_minutes: w.dwell_minutes,
      trigger_radius_miles: w.trigger_radius_miles,
      notification: w.notification
        ? {
            title: w.notification.title,
            message: w.notification.message,
            speech: w.notification.speech,
          }
        : undefined,
    })),
  };
}
