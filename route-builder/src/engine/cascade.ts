import type {
  ScheduledStop,
  TimelineCascadeInput,
  TimelineCascadeResult,
  BackwardScheduleInput,
  BackwardScheduleResult,
  TimelineCascadeWaypoint,
} from './types';

import tzlookup from 'tz-lookup';

/**
 * Longitude boundary between Arizona and New Mexico (~109° 02' 48" W).
 * Locations west of this coordinate (more negative) are in Arizona (America/Phoenix).
 * Locations east of this coordinate (less negative) are in New Mexico (America/Denver).
 */
export const AZ_NM_LONGITUDE_BOUNDARY = -109.0452;

/**
 * Default fallback timezone for the roadtrip co-pilot.
 */
export const DEFAULT_TIMEZONE = 'America/Phoenix';

/**
 * Detects timezone based on geographic coordinates or returns the fallback.
 * Uses exact global polygon resolution via tz-lookup.
 */
export function detectTimezone(
  lat: number,
  lng: number,
  fallback = DEFAULT_TIMEZONE
): string {
  if (typeof lat !== 'number' || typeof lng !== 'number' || isNaN(lat) || isNaN(lng)) {
    return fallback;
  }

  // Arizona corridor override: Arizona does not observe DST (America/Phoenix year-round).
  // Coarse polygon tz-lookup maps northern Arizona coordinates to America/Denver,
  // whereas state highway road trips across Arizona operate on Mountain Standard Time (America/Phoenix).
  if (lat >= 31.3 && lat <= 37.0 && lng < AZ_NM_LONGITUDE_BOUNDARY && lng >= -114.8) {
    return 'America/Phoenix';
  }

  try {
    return tzlookup(lat, lng);
  } catch {
    return fallback;
  }
}

/**
 * Calculates great-circle distance between two coordinate pairs using the Haversine formula in miles.
 */
export function haversineMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  if (lat1 === lat2 && lng1 === lng2) return 0;

  const R = 3958.8; // Earth's radius in statute miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Number((R * c).toFixed(2));
}

/**
 * Estimates driving duration in seconds based on distance in miles and average driving speed (mph).
 * Default average speed: 50 mph (accounting for scenic terrain, highways, and towns).
 */
export function estimateDriveDurationSeconds(
  distanceMiles: number,
  avgSpeedMph = 50
): number {
  if (distanceMiles <= 0 || avgSpeedMph <= 0) return 0;
  const hours = distanceMiles / avgSpeedMph;
  return Math.round(hours * 3600);
}

/**
 * Details extracted for a specific timestamp in a given IANA timezone.
 */
export interface TimezoneFormattedDetails {
  time: string; // "HH:mm:ss"
  shortTime: string; // "HH:mm"
  localDate: string; // "YYYY-MM-DD"
  offsetMinutes: number; // e.g. -420 or -360
  offsetStr: string; // e.g. "-07:00" or "-06:00"
  isoWithOffset: string; // "YYYY-MM-DDTHH:mm:ss±HH:mm"
  abbreviation: string; // e.g. "MST", "MDT"
}

/**
 * Formats a UTC epoch millisecond timestamp into localized strings and metadata for an IANA timezone.
 */
export function getTimezoneDetails(
  epochMs: number,
  timeZone: string
): TimezoneFormattedDetails {
  const date = new Date(epochMs);

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });

  const partsMap: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    partsMap[part.type] = part.value;
  }

  let hour = partsMap.hour || '00';
  if (hour === '24') hour = '00';
  const minute = partsMap.minute || '00';
  const second = partsMap.second || '00';
  const year = partsMap.year || '1970';
  const month = partsMap.month || '01';
  const day = partsMap.day || '01';
  const abbreviation = partsMap.timeZoneName || '';

  const time = `${hour}:${minute}:${second}`;
  const shortTime = `${hour}:${minute}`;
  const localDate = `${year}-${month}-${day}`;

  // Calculate true offset minutes at this epoch
  const naiveLocalEpoch = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );

  const offsetMinutes = Math.round((naiveLocalEpoch - epochMs) / 60000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);
  const offH = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const offM = String(absOffset % 60).padStart(2, '0');
  const offsetStr = `${sign}${offH}:${offM}`;
  const isoWithOffset = `${localDate}T${time}${offsetStr}`;

  return {
    time,
    shortTime,
    localDate,
    offsetMinutes,
    offsetStr,
    isoWithOffset,
    abbreviation,
  };
}

/**
 * Parses a local date string (YYYY-MM-DD) and time string (HH:mm:ss or HH:mm) in a specified IANA timezone
 * and computes the corresponding UTC Unix epoch milliseconds.
 */
export function parseLocalToUtcEpoch(
  baseDate: string,
  timeStr: string,
  timeZone: string
): number {
  if (!baseDate || !timeStr || !timeZone) {
    throw new Error('baseDate, timeStr, and timeZone are required to compute epoch timestamp');
  }

  const dateParts = baseDate.trim().split('-').map(Number);
  if (dateParts.length !== 3 || dateParts.some(isNaN)) {
    throw new Error(`Invalid baseDate format "${baseDate}": expected "YYYY-MM-DD"`);
  }
  const [year, month, day] = dateParts;

  const timeParts = timeStr.trim().split(':').map(Number);
  if (timeParts.length < 2 || timeParts.some(isNaN)) {
    throw new Error(`Invalid timeStr format "${timeStr}": expected "HH:mm:ss" or "HH:mm"`);
  }
  const hour = timeParts[0];
  const minute = timeParts[1];
  const second = timeParts[2] || 0;

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    throw new Error(`Time components out of bounds in "${timeStr}"`);
  }

  // Construct naive UTC timestamp first
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const getOffset = (instantUtc: number): number => {
    const partsMap: Record<string, string> = {};
    for (const part of formatter.formatToParts(new Date(instantUtc))) {
      partsMap[part.type] = part.value;
    }

    let localHour = Number(partsMap.hour || 0);
    if (localHour === 24) localHour = 0;

    const localEpoch = Date.UTC(
      Number(partsMap.year),
      Number(partsMap.month) - 1,
      Number(partsMap.day),
      localHour,
      Number(partsMap.minute || 0),
      Number(partsMap.second || 0)
    );

    return localEpoch - instantUtc;
  };

  // 2-pass fixed-point probe to handle DST boundaries accurately:
  // Pass 1: probe offset at naiveUtc
  const offsetMs1 = getOffset(naiveUtc);
  const candidateUtc = naiveUtc - offsetMs1;

  // Pass 2: probe offset at the candidate UTC instant
  const offsetMs2 = getOffset(candidateUtc);

  return naiveUtc - offsetMs2;
}

/**
 * Calculates the forward timeline cascade across a sequence of waypoints:
 * - Arrival_1 = DayDepartureTime
 * - Departure_1 = Arrival_1 + Dwell_1
 * - Arrival_2 = Departure_1 + DriveDuration(W1, W2)
 * - Departure_2 = Arrival_2 + Dwell_2
 * - ...
 * - Arrival_n = Departure_{n-1} + DriveDuration(W_{n-1}, W_n)
 * - Departure_n = Arrival_n + Dwell_n
 */
export function calculateTimelineCascade(
  input: TimelineCascadeInput
): TimelineCascadeResult {
  const {
    baseDate,
    departureTime,
    defaultTimezone = DEFAULT_TIMEZONE,
    waypoints,
    driveDurationsSeconds,
    driveDistancesMiles,
  } = input;

  if (!waypoints || waypoints.length === 0) {
    return {
      stops: [],
      totalDriveSeconds: 0,
      totalDriveMinutes: 0,
      totalDwellMinutes: 0,
      totalTripSeconds: 0,
      totalDistanceMiles: 0,
      startTime: '',
      endTime: '',
      timezonesCrossed: [],
    };
  }

  const stops: ScheduledStop[] = [];
  const timezonesSet = new Set<string>();

  // Determine timezone for the first stop
  const firstWp = waypoints[0];
  const firstTz =
    firstWp.timezone ||
    detectTimezone(firstWp.lat, firstWp.lng, defaultTimezone);
  timezonesSet.add(firstTz);

  const isAdHoc = Boolean(input.isAdHoc);
  const effectiveBaseDate = baseDate || new Date().toISOString().slice(0, 10);
  const effectiveDepTime = departureTime || '09:00:00';

  // Compute epoch for arrival at stop 0 (equals day departure time)
  let currentArrivalEpoch = parseLocalToUtcEpoch(effectiveBaseDate, effectiveDepTime, firstTz);
  let previousDepartureEpoch = currentArrivalEpoch;
  let previousTimezone = firstTz;
  let previousOffsetMinutes = 0;

  let totalDriveSeconds = 0;
  let totalDwellMinutes = 0;
  let totalDistanceMiles = 0;

  const formatOffsetMinutes = (mins: number): string => {
    if (mins === 0) return 'Start';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h === 0) return `+${m}m`;
    return `+${h}h ${m.toString().padStart(2, '0')}m`;
  };

  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    const isLast = i === waypoints.length - 1;
    const isOvernightOrFinalDest = isLast && (wp.type === 'lodging' || wp.type === 'destination');
    const dwellMinutes = isOvernightOrFinalDest ? 0 : Math.max(0, wp.dwell_minutes || 0);
    totalDwellMinutes += dwellMinutes;

    let driveDurationSec = 0;
    let driveDistanceMi = 0;

    if (i > 0) {
      const prevWp = waypoints[i - 1];

      // Use supplied OSRM pairwise duration/distance if available, otherwise fallback to haversine estimation
      if (
        driveDurationsSeconds &&
        driveDurationsSeconds.length >= i &&
        typeof driveDurationsSeconds[i - 1] === 'number'
      ) {
        driveDurationSec = driveDurationsSeconds[i - 1];
      } else {
        const estDist = haversineMiles(prevWp.lat, prevWp.lng, wp.lat, wp.lng);
        driveDurationSec = estimateDriveDurationSeconds(estDist);
      }

      if (
        driveDistancesMiles &&
        driveDistancesMiles.length >= i &&
        typeof driveDistancesMiles[i - 1] === 'number'
      ) {
        driveDistanceMi = driveDistancesMiles[i - 1];
      } else {
        driveDistanceMi = haversineMiles(prevWp.lat, prevWp.lng, wp.lat, wp.lng);
      }

      totalDriveSeconds += driveDurationSec;
      totalDistanceMiles += driveDistanceMi;

      // Arrival_i = Departure_{i-1} + Duration(W_{i-1}, W_i)
      currentArrivalEpoch = previousDepartureEpoch + driveDurationSec * 1000;
    }

    // Departure_i = Arrival_i + Dwell_i
    const departureEpoch = currentArrivalEpoch + dwellMinutes * 60 * 1000;

    // Resolve timezone for this stop
    const stopTz =
      wp.timezone || detectTimezone(wp.lat, wp.lng, defaultTimezone);
    timezonesSet.add(stopTz);

    const arrivalDetails = getTimezoneDetails(currentArrivalEpoch, stopTz);
    const departureDetails = getTimezoneDetails(departureEpoch, stopTz);

    const isBoundaryCrossing = i > 0 && stopTz !== previousTimezone;
    let timezoneShiftHours: number | undefined;
    if (isBoundaryCrossing) {
      timezoneShiftHours =
        (arrivalDetails.offsetMinutes - previousOffsetMinutes) / 60;
    }

    const firstStopArrivalEpoch = stops[0]?.arrivalEpochMs ?? currentArrivalEpoch;
    const offsetArrivalSec = i === 0 ? 0 : Math.round((currentArrivalEpoch - firstStopArrivalEpoch) / 1000);
    const offsetArrivalMin = Math.round(offsetArrivalSec / 60);
    const offsetDepartureSec = Math.round((departureEpoch - firstStopArrivalEpoch) / 1000);
    const offsetDepartureMin = Math.round(offsetDepartureSec / 60);

    const arrivalShortTime = isAdHoc
      ? (i === 0 ? 'Start' : formatOffsetMinutes(offsetArrivalMin))
      : arrivalDetails.shortTime;

    const departureShortTime = isAdHoc
      ? (i === 0 && dwellMinutes === 0 ? 'Start' : formatOffsetMinutes(offsetDepartureMin))
      : departureDetails.shortTime;

    const arrivalTime = isAdHoc ? formatOffsetMinutes(offsetArrivalMin) : arrivalDetails.time;
    const departureTime = isAdHoc ? formatOffsetMinutes(offsetDepartureMin) : departureDetails.time;

    stops.push({
      id: wp.id,
      name: wp.name,
      place_name: wp.place_name,
      type: wp.type || 'scenic_pull_off',
      lat: wp.lat,
      lng: wp.lng,
      dwell_minutes: dwellMinutes,
      trigger_radius_miles: wp.trigger_radius_miles ?? 1.0,
      notification: wp.notification,
      address: wp.address,
      google_place_id: wp.google_place_id,
      is_route_anchor: wp.is_route_anchor,
      approachHighway: wp.approachHighway,
      notes: wp.notes,
      timezone: stopTz,
      timezoneAbbreviation: arrivalDetails.abbreviation,
      timezoneOffsetMinutes: arrivalDetails.offsetMinutes,
      timezoneOffsetStr: arrivalDetails.offsetStr,
      arrivalTime,
      arrivalShortTime,
      departureTime,
      departureShortTime,
      offsetMinutesFromStart: offsetArrivalMin,
      localDate: arrivalDetails.localDate,
      arrivalIso: arrivalDetails.isoWithOffset,
      departureIso: departureDetails.isoWithOffset,
      arrivalEpochMs: currentArrivalEpoch,
      departureEpochMs: departureEpoch,
      driveDurationFromPreviousSeconds: driveDurationSec,
      driveDistanceMilesFromPrevious: driveDistanceMi,
      isTimezoneBoundaryCrossing: isBoundaryCrossing,
      timezoneShiftHours,
    });

    previousDepartureEpoch = departureEpoch;
    previousTimezone = stopTz;
    previousOffsetMinutes = arrivalDetails.offsetMinutes;
  }

  const finalStop = stops[stops.length - 1];
  const initialStop = stops[0];

  const totalTripSeconds =
    stops.length > 0
      ? Math.round((finalStop.departureEpochMs - initialStop.arrivalEpochMs) / 1000)
      : 0;

  const isRouted = Boolean(
    waypoints.length <= 1 ||
    (driveDurationsSeconds && driveDurationsSeconds.length > 0)
  );

  return {
    stops,
    totalDriveSeconds,
    totalDriveMinutes: Number((totalDriveSeconds / 60).toFixed(1)),
    totalDwellMinutes,
    totalTripSeconds,
    totalDistanceMiles: Number(totalDistanceMiles.toFixed(2)),
    startTime: isAdHoc ? 'Dynamic Start' : (initialStop ? initialStop.departureTime : ''),
    endTime: isAdHoc ? (stops.length > 0 ? formatOffsetMinutes(Math.round(totalTripSeconds / 60)) : '') : (finalStop ? finalStop.arrivalTime : ''),
    timezonesCrossed: Array.from(timezonesSet),
    isAdHoc,
    isRouted,
  };
}

/**
 * Backward scheduling mode ("The Flight Catch-up"):
 * Given a hard destination arrival time deadline (e.g. "16:30:00" at Albuquerque Sunport),
 * works backward by subtracting all intermediate drive durations and dwell times to determine
 * the required departure time at the origin stop.
 */
export function calculateBackwardSchedule(
  input: BackwardScheduleInput
): BackwardScheduleResult {
  const {
    baseDate,
    targetArrivalTime,
    destinationTimezone,
    defaultTimezone = DEFAULT_TIMEZONE,
    waypoints,
    driveDurationsSeconds,
    driveDistancesMiles,
  } = input;

  if (!waypoints || waypoints.length === 0) {
    throw new Error('Backward scheduling requires at least one waypoint');
  }

  const n = waypoints.length;
  const lastWp = waypoints[n - 1];
  const finalTz =
    lastWp.timezone ||
    destinationTimezone ||
    detectTimezone(lastWp.lat, lastWp.lng, defaultTimezone);

  // Target arrival epoch at final destination
  const targetArrivalEpoch = parseLocalToUtcEpoch(
    baseDate,
    targetArrivalTime,
    finalTz
  );

  // Work backward from destination to origin
  let currentArrivalEpoch = targetArrivalEpoch;

  for (let i = n - 1; i >= 1; i--) {
    const prevWp = waypoints[i - 1];
    const currWp = waypoints[i];

    let driveDurationSec = 0;
    if (
      driveDurationsSeconds &&
      driveDurationsSeconds.length >= i &&
      typeof driveDurationsSeconds[i - 1] === 'number'
    ) {
      driveDurationSec = driveDurationsSeconds[i - 1];
    } else {
      const dist = haversineMiles(prevWp.lat, prevWp.lng, currWp.lat, currWp.lng);
      driveDurationSec = estimateDriveDurationSeconds(dist);
    }

    const prevDwellMinutes = Math.max(0, prevWp.dwell_minutes || 0);

    // Departure_{i-1} = Arrival_i - DriveDuration(i-1, i)
    const prevDepartureEpoch = currentArrivalEpoch - driveDurationSec * 1000;

    // Arrival_{i-1} = Departure_{i-1} - Dwell_{i-1}
    const prevArrivalEpoch = prevDepartureEpoch - prevDwellMinutes * 60 * 1000;

    currentArrivalEpoch = prevArrivalEpoch;
  }

  // Arrival_0 is the required departure time for the day
  const firstWp = waypoints[0];
  const originTz =
    firstWp.timezone ||
    detectTimezone(firstWp.lat, firstWp.lng, defaultTimezone);

  const originDetails = getTimezoneDetails(currentArrivalEpoch, originTz);

  // Run forward cascade from required departure time to verify and return comprehensive schedule
  const cascadeResult = calculateTimelineCascade({
    baseDate: originDetails.localDate,
    departureTime: originDetails.time,
    defaultTimezone,
    waypoints,
    driveDurationsSeconds,
    driveDistancesMiles,
  });

  return {
    requiredDepartureTime: originDetails.time,
    originTimezone: originTz,
    targetArrivalTime,
    destinationTimezone: finalTz,
    cascadeResult,
  };
}

/**
 * Convenience helper to apply a dwell time modification to a stop and recompute the ripple cascade.
 * Modifying dwell_minutes on stop k shifts arrival and departure times on all subsequent stops k+1 .. n
 * by exactly deltaDwell (plus any timezone boundary changes).
 */
export function applyDwellDelta(
  input: TimelineCascadeInput,
  stopIndex: number,
  newDwellMinutes: number
): TimelineCascadeResult {
  if (stopIndex < 0 || stopIndex >= input.waypoints.length) {
    throw new Error(`Stop index ${stopIndex} out of bounds [0, ${input.waypoints.length - 1}]`);
  }

  const updatedWaypoints: TimelineCascadeWaypoint[] = input.waypoints.map(
    (wp, idx) => {
      if (idx === stopIndex) {
        return { ...wp, dwell_minutes: Math.max(0, newDwellMinutes) };
      }
      return wp;
    }
  );

  return calculateTimelineCascade({
    ...input,
    waypoints: updatedWaypoints,
  });
}
