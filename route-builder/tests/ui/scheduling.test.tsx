import { describe, it, expect } from 'vitest';
import { act, api, fixture, roadResponse, mountApp, header, sidebar, tabs, trip, mapClick, selectTrip, saved, exportProps, exported } from './harness';
import { calculateTimelineCascade, detectTimezone, parseLocalToUtcEpoch } from '../../src/engine/cascade';
import { formatMultiDayItinerary, type SingleRouteItineraryV2 } from '../../src/engine/export';
import { parseItineraryJson } from '../../src/engine/itineraryParser';
import type { Waypoint, RouteResponse } from '../../src/types/routing';

describe('Scheduling acceptance workflows', () => {
  it('keeps edits when switching days and adding days', async () => {
    const app = await mountApp();
    await act(async () => sidebar(app).onUpdateWaypoint('d1_stop', { dwell_minutes: 90 }));
    await act(async () => tabs(app).onSelectDay(1));
    await act(async () => header(app).onSaveTrip());
    expect(saved().days[0].checkpoints[2].target_time).toBe('12:00:00');
    await act(async () => tabs(app).onSelectDay(0));
    await act(async () => tabs(app).onAddDay());
    expect(header(app).schedulingMode).toBe('forward');
    expect((await exported(exportProps(app))).days[0].checkpoints[2].target_time).toBe('12:00:00');
  });

  it('preserves known schedules in every export scope when routing fails', async () => {
    api.fetchRoute.mockRejectedValue(new Error('Router unavailable'));
    const app = await mountApp();
    await act(async () => header(app).onSaveTrip());
    expect(saved().days[0].checkpoints[2].target_time).toBe('11:00:00');
    expect((await exported(exportProps(app))).days[0].checkpoints[2].target_time).toBe('11:00:00');
    expect((await exported(exportProps(app), 'day')).days[0].checkpoints[2].target_time).toBe('11:00:00');
  });

  it('preserves single-route and relative schedules under failure without inventing offsets', async () => {
    api.fetchItinerary.mockResolvedValue({ trip_name: 'Single', date: '2026-10-09', timezone: 'America/Phoenix', checkpoints: fixture().days[0].checkpoints });
    api.fetchRoute.mockRejectedValue(new Error('Router unavailable'));
    const app = await mountApp();
    expect((await exported(exportProps(app))).days[0].checkpoints[2].target_time).toBe('11:00:00');
    await act(async () => header(app).setSchedulingMode('adhoc'));
    const relative = await exported<SingleRouteItineraryV2>(exportProps(app));
    expect(relative.checkpoints[2].offset_minutes_from_start).toBe(120);
    expect(relative.checkpoints[2].target_time).toBeUndefined();
    await act(async () => header(app).onSaveTrip());
    expect(saved<SingleRouteItineraryV2>().checkpoints[2].offset_minutes_from_start).toBe(120);
  });

  it('preserves valid westbound local clocks on Save and Export', async () => {
    const waypoints: Waypoint[] = [
      { id: 'nm', name: 'NM origin', type: 'origin', lat: 34.18, lng: -109, timezone: 'America/Denver', dwell_minutes: 0, trigger_radius_miles: 0.5 },
      { id: 'az', name: 'AZ destination', type: 'destination', lat: 34.16, lng: -109.1, timezone: 'America/Phoenix', dwell_minutes: 0, trigger_radius_miles: 0.5 },
    ];
    api.fetchItinerary.mockResolvedValue(formatMultiDayItinerary({ tripName: 'Westbound', days: [{ dayNumber: 1, date: '2026-10-09', departureTime: '09:00:00', timezone: 'America/Denver', scheduledStops: calculateTimelineCascade({ baseDate: '2026-10-09', departureTime: '09:00:00', waypoints, driveDurationsSeconds: [1800] }).stops }] }));
    api.fetchRoute.mockResolvedValue(roadResponse([1800]));
    const app = await mountApp();
    await act(async () => header(app).onSaveTrip());
    expect(saved().days[0].checkpoints[1].target_time).toBe('08:30:00');
    expect((await exported(exportProps(app))).days[0].checkpoints[1].target_time).toBe('08:30:00');
  });

  it('detects geographic zones for search, map, and coordinate edits', async () => {
    api.fetchItinerary.mockResolvedValue({ trip_name: 'New', date: '2026-10-09', timezone: 'America/Phoenix', checkpoints: [] });
    api.fetchRoute.mockResolvedValue(roadResponse([1800]));
    const app = await mountApp();
    await act(async () => sidebar(app).onSelectLocation({ lat: 40.75, lng: -73.99, name: 'NY origin', displayName: 'New York, NY' }));
    await act(async () => mapClick(app, 40.78, -73.96));
    const first = header(app).cascadeResult.stops[0];
    expect(first.timezone).toBe('America/New_York');
    expect(first.arrivalEpochMs).toBe(parseLocalToUtcEpoch('2026-10-09', '09:00:00', 'America/New_York'));
    await act(async () => header(app).onSaveTrip());
    expect(saved<SingleRouteItineraryV2>().checkpoints[0].timezone).toBe('America/New_York');
    expect((await exported(exportProps(app))).days[0].checkpoints[0].timezone).toBe('America/New_York');
    const id = trip(app).days[0].waypoints[0].id;
    await act(async () => sidebar(app).onUpdateWaypoint(id, { lat: 33.43, lng: -112.01 }));
    expect(trip(app).days[0].waypoints[0].timezone).toBe('America/Phoenix');
  });

  it('honors Navajo Nation and neighboring-state timezones rather than an Arizona rectangle', () => {
    expect(detectTimezone(35.68, -109.052)).toBe('America/Denver');
    expect(detectTimezone(34.848, -114.615)).toBe('America/Los_Angeles');
    expect(detectTimezone(35.19, -111.62)).toBe('America/Phoenix');
  });

  it('keeps an unresolved inactive stop unscheduled, then repairs it after routing', async () => {
    let release!: (value: RouteResponse) => void;
    api.fetchRoute.mockResolvedValueOnce(roadResponse()).mockReturnValueOnce(new Promise<RouteResponse>(resolve => { release = resolve })).mockResolvedValue(roadResponse());
    const app = await mountApp();
    await act(async () => mapClick(app));
    await act(async () => tabs(app).onSelectDay(1));
    await act(async () => header(app).onSaveTrip());
    const draft = saved().days[0].checkpoints[3];
    expect(draft.target_time).toBeUndefined();
    expect(draft.offset_minutes_from_start).toBeUndefined();
    const output = await exported(exportProps(app));
    expect(output.days[0].checkpoints[1].target_time).toBe('10:00:00');
    expect(output.days[0].checkpoints[3].offset_minutes_from_start).toBeUndefined();
    await act(async () => release(roadResponse([3600, 1800, 1200])));
    expect(trip(app).days[0].waypoints[3].target_time).toBe('11:20:00');
    expect(trip(app).days[0].waypoints[3].offset_minutes_from_start).toBe(140);
    await act(async () => header(app).onSaveTrip());
    expect(saved().days[0].checkpoints[3].target_time).toBe('11:20:00');
  });

  it('repairs inactive Catch-Up days to their deadline and restores per-day controls', async () => {
    let release!: (value: RouteResponse) => void;
    api.fetchRoute.mockResolvedValueOnce(roadResponse()).mockReturnValueOnce(new Promise<RouteResponse>(resolve => { release = resolve })).mockResolvedValue(roadResponse());
    const app = await mountApp();
    await act(async () => { header(app).setSchedulingMode('backward'); header(app).setTargetArrivalTime('16:00:00') });
    await act(async () => mapClick(app));
    await act(async () => tabs(app).onSelectDay(1));
    expect(header(app).schedulingMode).toBe('forward');
    await act(async () => release(roadResponse([3600, 1800, 1200])));
    expect(trip(app).days[0].waypoints[3].target_time).toBe('16:00:00');
    await act(async () => header(app).onSaveTrip());
    const output = await exported(exportProps(app));
    expect(output.days[0].checkpoints[3].target_time).toBe('16:00:00');
    expect(output.days[0].scheduling_mode).toBe('backward');
    await act(async () => tabs(app).onSelectDay(0));
    expect(header(app).schedulingMode).toBe('backward');
    expect(header(app).targetArrivalTime).toBe('16:00:00');
  });

  it('restores saved Catch-Up intent on initial load and same-coordinate trip selection', async () => {
    const raw = fixture();
    raw.days[0].scheduling_mode = 'backward'; raw.days[0].target_arrival_time = '16:00:00';
    api.fetchItinerary.mockResolvedValue(raw);
    const app = await mountApp();
    expect(header(app).schedulingMode).toBe('backward');
    expect(header(app).targetArrivalTime).toBe('16:00:00');
    expect(header(app).cascadeResult.stops[2].arrivalTime).toBe('16:00:00');
    raw.days[0].target_arrival_time = '17:00:00';
    await act(async () => selectTrip(app, parseItineraryJson(raw, 'second.json')));
    expect(header(app).schedulingMode).toBe('backward');
    expect(header(app).cascadeResult.stops[2].arrivalTime).toBe('17:00:00');
    expect(header(app).cascadeResult.isRouted).toBe(true);
  });

  it('starts added days in forward mode and restores the neighbor when a selected day is deleted', async () => {
    const app = await mountApp();
    await act(async () => { header(app).setSchedulingMode('backward'); header(app).setTargetArrivalTime('16:00:00') });
    await act(async () => tabs(app).onAddDay());
    expect(header(app).schedulingMode).toBe('forward');
    expect(header(app).cascadeResult.stops[0].arrivalTime).toBe('09:00:00');
    await act(async () => tabs(app).onSelectDay(0));
    await act(async () => tabs(app).onDeleteDay(0));
    expect(header(app).schedulingMode).toBe('forward');
  });

  it('does not strip dated days or truncate full-trip export when another day is ad-hoc', async () => {
    const app = await mountApp();
    await act(async () => header(app).setSchedulingMode('adhoc'));
    await act(async () => header(app).onSaveTrip());
    expect(saved().days[0].checkpoints[2].target_time).toBeUndefined();
    expect(saved().days[0].checkpoints[2].offset_minutes_from_start).toBe(120);
    expect(saved().days[1].checkpoints[2].target_time).toBe('11:00:00');
    const full = await exported(exportProps(app));
    expect(full.days).toHaveLength(2);
    expect(full.days[1].checkpoints[2].target_time).toBe('11:00:00');
    const one = await exported<SingleRouteItineraryV2>(exportProps(app), 'day');
    expect(one.checkpoints[2].offset_minutes_from_start).toBe(120);
    await act(async () => tabs(app).onSelectDay(1));
    expect(header(app).schedulingMode).toBe('forward');
  });

  it('retains valid road data when deleting a selected day with identical coordinates', async () => {
    const raw = fixture();
    raw.days[1].checkpoints = raw.days[0].checkpoints.map((cp) => ({ ...cp }));
    api.fetchItinerary.mockResolvedValue(raw);
    const app = await mountApp();
    await act(async () => tabs(app).onDeleteDay(0));
    expect(header(app).cascadeResult.isRouted).toBe(true);
    await act(async () => sidebar(app).onUpdateWaypoint('d1_stop', { dwell_minutes: 90 }));
    expect(header(app).cascadeResult.stops[2].arrivalTime).toBe('12:00:00');
  });

  it('never promotes incomplete road legs into a saved schedule', async () => {
    api.fetchRoute.mockResolvedValue(roadResponse([3600]));
    const app = await mountApp();
    expect(header(app).cascadeResult.isRouted).toBe(false);
    await act(async () => header(app).onSaveTrip());
    expect(saved().days[0].checkpoints[2].target_time).toBe('11:00:00');
  });

  it('invalidates edited coordinates until matching road data arrives, retaining supplied draft inputs', async () => {
    let release!: (value: RouteResponse) => void;
    const app = await mountApp();
    api.fetchRoute.mockReturnValueOnce(new Promise<RouteResponse>(resolve => { release = resolve }));
    await act(async () => sidebar(app).onUpdateWaypoint('d1_stop', { lat: 33.25 }));
    expect(header(app).isLoadingRoute).toBe(true);
    await act(async () => tabs(app).onSelectDay(1));
    await act(async () => header(app).onSaveTrip());
    expect(saved().days[0].checkpoints[1].target_time).toBeUndefined();
    expect(saved().days[0].checkpoints[2].offset_minutes_from_start).toBeUndefined();
    await act(async () => release(roadResponse([5400, 1800])));
    expect(trip(app).days[0].waypoints[2].target_time).toBe('11:30:00');
  });

  it('persists date/departure edits and relative drafts without fabricated clocks when routing fails', async () => {
    api.fetchRoute.mockRejectedValue(new Error('Router unavailable'));
    api.fetchItinerary.mockResolvedValue({ trip_name: 'Single', date: '2026-10-09', checkpoints: fixture().days[0].checkpoints });
    const app = await mountApp();
    await act(async () => { header(app).setDepartureTime('10:00:00'); header(app).setBaseDate('2026-10-10') });
    await act(async () => header(app).onSaveTrip());
    const output = saved<SingleRouteItineraryV2>();
    expect(output.departure_time).toBe('10:00:00');
    expect(output.date).toBe('2026-10-10');
    expect(output.checkpoints[0].target_time).toBeUndefined();
    expect(parseItineraryJson(output).days[0].departureTime).toBe('10:00:00');
    await act(async () => header(app).setSchedulingMode('adhoc'));
    const draft = await exported<SingleRouteItineraryV2>(exportProps(app));
    expect(draft.checkpoints[1].offset_minutes_from_start).toBeUndefined();
  });

  it('ignores stale results from a replaced trip, even when its coordinates are identical', async () => {
    let release!: (value: RouteResponse) => void;
    api.fetchRoute.mockReturnValueOnce(new Promise<RouteResponse>(resolve => { release = resolve })).mockResolvedValue(roadResponse());
    const app = await mountApp();
    const next = parseItineraryJson(fixture(), 'replacement.json');
    await act(async () => selectTrip(app, next));
    expect(header(app).cascadeResult.isRouted).toBe(true);
    await act(async () => release(roadResponse([18000, 18000])));
    expect(trip(app).days[0].waypoints[2].target_time).toBe('11:00:00');
  });

  it('does not erase newer edits or reset the selected day when a slow Save finishes', async () => {
    let finish!: () => void;
    api.saveItinerary.mockReturnValue(new Promise<void>(resolve => { finish = resolve }));
    const app = await mountApp();
    let saving!: Promise<void>;
    await act(async () => { saving = header(app).onSaveTrip() });
    await act(async () => tabs(app).onSelectDay(1));
    await act(async () => sidebar(app).onUpdateWaypoint('d2_stop', { dwell_minutes: 90 }));
    await act(async () => { finish(); await saving });
    expect(trip(app).days[1].waypoints[1].dwell_minutes).toBe(90);
    expect(header(app).cascadeResult.stops[2].arrivalTime).toBe('12:00:00');
    expect(new URL(window.location.href).searchParams.get('day')).toBe('1');
    expect(header(app).isDirty).toBe(true);
  });
});
