import type { RouteService } from '../routeService.js';
import { detectTimezone } from './geo.js';
import type { ScoutToolExecutionContext, ScoutWaypointSummary } from './types.js';

export interface ScheduleCascadeResult {
  action: string;
  target_waypoint_id: string;
  start_time: string;
  end_time: string;
  total_drive_minutes: number;
  total_dwell_minutes: number;
  total_distance_miles: number;
  timezones_crossed: string[];
  sunset_warnings: Array<{
    id: string;
    name: string;
    arrival_time: string;
    timezone: string;
  }>;
  stops: Array<{
    id: string;
    name: string;
    type: string;
    lat: number;
    lng: number;
    arrival_time: string;
    departure_time: string;
    dwell_minutes: number;
    drive_minutes_from_previous: number;
    distance_miles_from_previous: number;
    timezone: string;
  }>;
}

/**
 * Simulates the forward schedule cascade across the day upon adding, updating, or deleting a waypoint,
 * recalculating arrival and departure times, timezone changes, and sunset warnings.
 */
export async function simulateScheduleCascadeTool(
  args: Record<string, unknown>,
  context: ScoutToolExecutionContext,
  routeService: RouteService
): Promise<ScheduleCascadeResult> {
  const action = typeof args.action === 'string' ? args.action.trim() : '';
  if (action !== 'add' && action !== 'update' && action !== 'delete') {
    throw new Error('Invalid action: must be "add", "update", or "delete"');
  }

  const targetId = typeof args.target_waypoint_id === 'string' ? args.target_waypoint_id.trim() : '';
  if (!targetId) {
    throw new Error('Missing required "target_waypoint_id" argument');
  }

  if (args.dwell_minutes !== undefined && args.dwell_minutes !== null) {
    if (typeof args.dwell_minutes !== 'number' || !Number.isFinite(args.dwell_minutes) || args.dwell_minutes < 0) {
      throw new Error('Invalid dwell_minutes: must be a non-negative finite number');
    }
  }

  const originalWaypoints = context.tripContext?.waypoints;
  if (!Array.isArray(originalWaypoints)) {
    throw new Error('Trip context waypoints must be an array');
  }

  interface SimulationWaypoint extends ScoutWaypointSummary {
    origIndex?: number;
  }

  const waypoints: SimulationWaypoint[] = originalWaypoints.map((w, index) => ({ ...w, origIndex: index }));
  const idx = waypoints.findIndex((w) => w.id === targetId);
  if (idx === -1) {
    throw new Error(
      `Target waypoint "${targetId}" not found in active trip context. Available IDs: ${waypoints.map((w) => w.id).join(', ')}`
    );
  }

  if (action === 'add') {
    if (
      typeof args.candidate_lat !== 'number' ||
      !Number.isFinite(args.candidate_lat) ||
      args.candidate_lat < -90 ||
      args.candidate_lat > 90
    ) {
      throw new Error('Missing or invalid candidate_lat [-90, 90] for action "add"');
    }
    if (
      typeof args.candidate_lng !== 'number' ||
      !Number.isFinite(args.candidate_lng) ||
      args.candidate_lng < -180 ||
      args.candidate_lng > 180
    ) {
      throw new Error('Missing or invalid candidate_lng [-180, 180] for action "add"');
    }
    const candidateName =
      typeof args.candidate_name === 'string' && args.candidate_name.trim()
        ? args.candidate_name.trim()
        : 'Candidate Stop';
    const candidateType =
      typeof args.candidate_type === 'string' && args.candidate_type.trim()
        ? args.candidate_type.trim()
        : 'scenic_pull_off';
    const dwell = typeof args.dwell_minutes === 'number' ? args.dwell_minutes : 15;

    const newWp: SimulationWaypoint = {
      id: `sim_add_${Date.now()}`,
      name: candidateName,
      type: candidateType,
      lat: Number(args.candidate_lat.toFixed(6)),
      lng: Number(args.candidate_lng.toFixed(6)),
      dwell_minutes: dwell,
      origIndex: undefined,
    };
    waypoints.splice(idx + 1, 0, newWp);
  } else if (action === 'update') {
    const existing = waypoints[idx];
    const hasCandLat = args.candidate_lat !== undefined && args.candidate_lat !== null;
    const hasCandLng = args.candidate_lng !== undefined && args.candidate_lng !== null;
    if (hasCandLat !== hasCandLng) {
      throw new Error('Both "candidate_lat" and "candidate_lng" must be provided together when updating coordinates');
    }
    if (hasCandLat && hasCandLng) {
      if (
        typeof args.candidate_lat !== 'number' ||
        !Number.isFinite(args.candidate_lat) ||
        args.candidate_lat < -90 ||
        args.candidate_lat > 90 ||
        typeof args.candidate_lng !== 'number' ||
        !Number.isFinite(args.candidate_lng) ||
        args.candidate_lng < -180 ||
        args.candidate_lng > 180
      ) {
        throw new Error('Invalid candidate_lat/candidate_lng for action "update": must be finite numbers in [-90, 90] and [-180, 180]');
      }
      existing.lat = Number((args.candidate_lat as number).toFixed(6));
      existing.lng = Number((args.candidate_lng as number).toFixed(6));
    }
    if (typeof args.dwell_minutes === 'number') {
      existing.dwell_minutes = args.dwell_minutes;
    }
    if (typeof args.candidate_name === 'string' && args.candidate_name.trim()) {
      existing.name = args.candidate_name.trim();
    }
    if (typeof args.candidate_type === 'string' && args.candidate_type.trim()) {
      existing.type = args.candidate_type.trim();
    }
  } else if (action === 'delete') {
    waypoints.splice(idx, 1);
  }

  if (waypoints.length === 0) {
    return {
      action,
      target_waypoint_id: targetId,
      start_time: '08:00',
      end_time: '08:00',
      total_drive_minutes: 0,
      total_dwell_minutes: 0,
      total_distance_miles: 0,
      timezones_crossed: [],
      sunset_warnings: [],
      stops: [],
    };
  }

  const departureTimeStr = (context.tripContext.departureTime || '08:00:00').trim();
  if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(departureTimeStr)) {
    throw new Error(`Invalid departureTime format "${departureTimeStr}": expected "HH:mm" or "HH:mm:ss"`);
  }

  const tripDate = (context.tripContext.date || '2026-10-10').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tripDate)) {
    throw new Error(`Invalid trip date format "${tripDate}": expected "YYYY-MM-DD"`);
  }

  const resolveValidTimezone = (wp: ScoutWaypointSummary): string => {
    if (wp.timezone && typeof wp.timezone === 'string') {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: wp.timezone });
        return wp.timezone;
      } catch {
        throw new Error(`Invalid IANA timezone "${wp.timezone}" on waypoint "${wp.id}"`);
      }
    }
    return detectTimezone(wp.lat, wp.lng);
  };

  const originTz = resolveValidTimezone(waypoints[0]);

  // Compute start epoch
  const [depH = '08', depM = '00', depS = '00'] = departureTimeStr.split(':');
  const [yearStr = '2026', monthStr = '10', dayStr = '10'] = tripDate.split('-');
  const hNum = parseInt(depH, 10);
  const mNum = parseInt(depM, 10);
  const sNum = parseInt(depS, 10);
  if (hNum < 0 || hNum > 23 || mNum < 0 || mNum > 59 || sNum < 0 || sNum > 59) {
    throw new Error(`Departure time out of bounds: "${departureTimeStr}"`);
  }

  let currentEpoch = Date.UTC(
    parseInt(yearStr, 10),
    parseInt(monthStr, 10) - 1,
    parseInt(dayStr, 10),
    hNum,
    mNum,
    sNum
  );

  // Refine start epoch to origin timezone
  const originFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: originTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  for (let iter = 0; iter < 3; iter++) {
    const partsMap: Record<string, string> = {};
    for (const p of originFormatter.formatToParts(new Date(currentEpoch))) {
      partsMap[p.type] = p.value;
    }
    let ph = partsMap.hour || '00';
    if (ph === '24') ph = '00';
    const actualNaive = Date.UTC(
      parseInt(partsMap.year || '2026', 10),
      parseInt(partsMap.month || '10', 10) - 1,
      parseInt(partsMap.day || '10', 10),
      parseInt(ph, 10),
      parseInt(partsMap.minute || '00', 10),
      parseInt(partsMap.second || '00', 10)
    );
    const targetNaive = Date.UTC(
      parseInt(yearStr, 10),
      parseInt(monthStr, 10) - 1,
      parseInt(dayStr, 10),
      hNum,
      mNum,
      sNum
    );
    const diff = actualNaive - targetNaive;
    if (diff === 0) break;
    currentEpoch -= diff;
  }

  const timezonesSet = new Set<string>();
  const sunsetWarnings: Array<{ id: string; name: string; arrival_time: string; timezone: string }> = [];
  const stops: Array<{
    id: string;
    name: string;
    type: string;
    lat: number;
    lng: number;
    arrival_time: string;
    departure_time: string;
    dwell_minutes: number;
    drive_minutes_from_previous: number;
    distance_miles_from_previous: number;
    timezone: string;
  }> = [];

  interface LegMeasurement {
    distMiles: number;
    driveSec: number;
  }

  const legMeasurements: LegMeasurement[] = new Array(waypoints.length);
  const legRoutingTasks: Array<{ legIdx: number; promise: Promise<LegMeasurement> }> = [];

  for (let i = 1; i < waypoints.length; i++) {
    const prev = waypoints[i - 1];
    const wp = waypoints[i];
    const isUnchanged =
      prev.origIndex !== undefined &&
      wp.origIndex !== undefined &&
      wp.origIndex === prev.origIndex + 1 &&
      Math.abs(originalWaypoints[prev.origIndex].lat - prev.lat) < 1e-6 &&
      Math.abs(originalWaypoints[prev.origIndex].lng - prev.lng) < 1e-6 &&
      Math.abs(originalWaypoints[wp.origIndex].lat - wp.lat) < 1e-6 &&
      Math.abs(originalWaypoints[wp.origIndex].lng - wp.lng) < 1e-6 &&
      typeof wp.drive_duration_minutes === 'number' &&
      Number.isFinite(wp.drive_duration_minutes) &&
      wp.drive_duration_minutes >= 0 &&
      typeof wp.drive_distance_miles === 'number' &&
      Number.isFinite(wp.drive_distance_miles) &&
      wp.drive_distance_miles >= 0;

    if (isUnchanged) {
      legMeasurements[i] = {
        distMiles: wp.drive_distance_miles as number,
        driveSec: Math.round((wp.drive_duration_minutes as number) * 60),
      };
    } else {
      const coordString = `${Number(prev.lng.toFixed(6))},${Number(prev.lat.toFixed(6))};${Number(wp.lng.toFixed(6))},${Number(wp.lat.toFixed(6))}`;
      legRoutingTasks.push({
        legIdx: i,
        promise: (async () => {
          const routeRes = await routeService.getRoute(coordString, undefined, context.abortSignal);
          const distMiles = routeRes.distanceMiles;
          const driveSec =
            typeof routeRes.durationSeconds === 'number' && Number.isFinite(routeRes.durationSeconds)
              ? routeRes.durationSeconds
              : Math.round(routeRes.durationMinutes * 60);
          return { distMiles, driveSec };
        })(),
      });
    }
  }

  if (legRoutingTasks.length > 0) {
    const taskResults = await Promise.all(legRoutingTasks.map((t) => t.promise));
    for (let t = 0; t < legRoutingTasks.length; t++) {
      legMeasurements[legRoutingTasks[t].legIdx] = taskResults[t];
    }
  }

  let totalDriveSeconds = 0;
  let totalDwellMinutes = 0;
  let totalDistanceMiles = 0;

  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    const tz = resolveValidTimezone(wp);
    timezonesSet.add(tz);

    let driveSec = 0;
    let distMiles = 0;

    if (i > 0) {
      const leg = legMeasurements[i];
      distMiles = leg.distMiles;
      driveSec = leg.driveSec;
      totalDriveSeconds += driveSec;
      totalDistanceMiles += distMiles;
    }

    currentEpoch += driveSec * 1000;
    const arrivalEpoch = currentEpoch;

    const stopFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    const arrivalParts: Record<string, string> = {};
    for (const p of stopFormatter.formatToParts(new Date(arrivalEpoch))) {
      arrivalParts[p.type] = p.value;
    }
    let arrH = arrivalParts.hour || '00';
    if (arrH === '24') arrH = '00';
    const arrM = arrivalParts.minute || '00';
    const arrivalTime = `${arrH}:${arrM}`;

    const hourNum = parseInt(arrH, 10);
    const minNum = parseInt(arrM, 10);
    if (hourNum > 18 || (hourNum === 18 && minNum >= 30)) {
      sunsetWarnings.push({
        id: wp.id,
        name: wp.name,
        arrival_time: arrivalTime,
        timezone: tz,
      });
    }

    const isLast = i === waypoints.length - 1;
    const isOvernightOrFinalDest = isLast && (wp.type === 'lodging' || wp.type === 'destination');
    const dwell = isOvernightOrFinalDest ? 0 : Math.max(0, wp.dwell_minutes ?? 0);
    totalDwellMinutes += dwell;
    currentEpoch += dwell * 60 * 1000;
    const departureEpoch = currentEpoch;

    const depParts: Record<string, string> = {};
    for (const p of stopFormatter.formatToParts(new Date(departureEpoch))) {
      depParts[p.type] = p.value;
    }
    let dH = depParts.hour || '00';
    if (dH === '24') dH = '00';
    const dM = depParts.minute || '00';
    const departureTime = `${dH}:${dM}`;

    stops.push({
      id: wp.id,
      name: wp.name,
      type: wp.type,
      lat: wp.lat,
      lng: wp.lng,
      arrival_time: arrivalTime,
      departure_time: departureTime,
      dwell_minutes: dwell,
      drive_minutes_from_previous: Number((driveSec / 60).toFixed(1)),
      distance_miles_from_previous: Number(distMiles.toFixed(2)),
      timezone: tz,
    });
  }

  return {
    action,
    target_waypoint_id: targetId,
    start_time: stops[0]?.departure_time || '08:00',
    end_time: stops[stops.length - 1]?.arrival_time || '08:00',
    total_drive_minutes: Number((totalDriveSeconds / 60).toFixed(1)),
    total_dwell_minutes: totalDwellMinutes,
    total_distance_miles: Number(totalDistanceMiles.toFixed(2)),
    timezones_crossed: Array.from(timezonesSet),
    sunset_warnings: sunsetWarnings,
    stops,
  };
}
