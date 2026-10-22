import { describe, it, expect } from 'vitest';
import type { ReactTestInstance } from 'react-test-renderer';
import { act, api, fixture, roadResponse, mountApp, header, sidebar, tabs, trip, mapClick, selectTrip, selectorProps, saved, exportProps, exported, points, stubWindowLocation } from './harness';
import { calculateTimelineCascade, detectTimezone, parseLocalToUtcEpoch } from '../../src/engine/cascade';
import { formatMultiDayItinerary, type SingleRouteItineraryV2 } from '../../src/engine/export';
import { parseItineraryJson, type ParsedTrip } from '../../src/engine/itineraryParser';
import { createSampleTrip } from '../../src/engine/sampleTrip';
import type { Waypoint, RouteResponse } from '../../src/types/routing';
import { AuthGateScreen } from '../../src/components/AuthGateScreen';

function textOf(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
}

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
    let finish!: (value: { success: boolean; fileName: string; etag: string }) => void;
    api.saveItinerary.mockReturnValue(new Promise<{ success: boolean; fileName: string; etag: string }>(resolve => { finish = resolve }));
    const app = await mountApp();
    let saving!: Promise<void>;
    await act(async () => { saving = header(app).onSaveTrip() });
    await act(async () => tabs(app).onSelectDay(1));
    await act(async () => sidebar(app).onUpdateWaypoint('d2_stop', { dwell_minutes: 90 }));
    await act(async () => { finish({ success: true, fileName: 'test.json', etag: '"etag-saved"' }); await saving });
    expect(trip(app).days[1].waypoints[1].dwell_minutes).toBe(90);
    expect(header(app).cascadeResult.stops[2].arrivalTime).toBe('12:00:00');
    expect(new URL(window.location.href).searchParams.get('day')).toBe('1');
    expect(header(app).isDirty).toBe(true);
    expect(window.alert).not.toHaveBeenCalled();
  });

  it('does not restore trip A when switching to trip B during trip A slow save', async () => {
    let finish!: (value: { success: boolean; fileName: string; etag: string }) => void;
    api.saveItinerary.mockReturnValue(new Promise<{ success: boolean; fileName: string; etag: string }>((resolve) => { finish = resolve }));
    const app = await mountApp();
    let saving!: Promise<void>;
    await act(async () => { saving = header(app).onSaveTrip() });

    // While saving trip A, user selects trip B
    const tripB = parseItineraryJson(
      {
        trip_name: 'Trip B Destination',
        days: [
          {
            dayNumber: 1,
            date: '2026-10-15',
            departureTime: '10:00:00',
            waypoints: points(1),
          },
        ],
      },
      'trip_b.json'
    );
    await act(async () => { selectTrip(app, tripB) });

    expect(trip(app).tripName).toBe('Trip B Destination');
    expect(new URL(window.location.href).searchParams.get('route')).toBe('trip_b.json');

    // Trip A's save resolves
    await act(async () => { finish({ success: true, fileName: 'test.json', etag: '"etag-saved"' }); await saving });

    // Active trip MUST STILL be Trip B, NOT restored to Trip A
    expect(trip(app).tripName).toBe('Trip B Destination');
    expect(new URL(window.location.href).searchParams.get('route')).toBe('trip_b.json');
    expect(window.alert).not.toHaveBeenCalled();
  });

  it('sends If-None-Match: * on save when trip has no etag, and If-Match when etag is present', async () => {
    const app = await mountApp();

    // Fresh trip without etag
    const tripWithoutEtag = { ...trip(app), etag: undefined };
    await act(async () => { selectTrip(app, tripWithoutEtag) });
    await act(async () => { await header(app).onSaveTrip() });

    expect(api.saveItinerary).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(Object),
      { ifNoneMatch: '*' }
    );

    // Trip with etag
    const tripWithEtag = { ...trip(app), etag: '"etag-12345"' };
    await act(async () => { selectTrip(app, tripWithEtag) });
    await act(async () => { await header(app).onSaveTrip() });

    expect(api.saveItinerary).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(Object),
      { ifMatch: '"etag-12345"' }
    );
  });

  it('leaves isDirty false after saving a blank trip without further edits', async () => {
    const app = await mountApp();
    const blankTrip: ParsedTrip = {
      tripName: 'Brand New Trip',
      isMultiDay: false,
      days: [
        {
          dayNumber: 1,
          date: '2026-10-10',
          title: 'Brand New Trip',
          departureTime: '09:00:00',
          timezone: 'America/Phoenix',
          waypoints: [],
        },
      ],
    };
    await act(async () => {
      selectTrip(app, blankTrip);
    });

    expect(header(app).isDirty).toBe(false);

    await act(async () => {
      await header(app).onSaveTrip();
    });

    expect(header(app).isDirty).toBe(false);
    expect(window.alert).not.toHaveBeenCalled();
  });

  it('recovers from 412 filename collision by renaming the trip and saving under the new filename', async () => {
    const app = await mountApp();
    const importedTrip: ParsedTrip = {
      tripName: 'Existing Collision Trip',
      fileName: 'collision_route.json',
      etag: undefined,
      isMultiDay: false,
      days: [
        {
          dayNumber: 1,
          date: '2026-10-10',
          title: 'Existing Collision Trip',
          departureTime: '09:00:00',
          timezone: 'America/Phoenix',
          waypoints: points(1),
        },
      ],
    };
    await act(async () => {
      selectTrip(app, importedTrip);
    });

    api.saveItinerary.mockRejectedValueOnce(new api.ApiError('Precondition Failed', 412));
    await act(async () => {
      await header(app).onSaveTrip();
    });

    expect(window.alert).toHaveBeenCalledWith(
      expect.stringContaining('Conflict detected')
    );

    // Renaming the trip should update tripName and derive new fileName, resetting conflict
    await act(async () => {
      header(app).onRenameTrip('Unique Route Name');
    });

    expect(trip(app).tripName).toBe('Unique Route Name');
    expect(trip(app).fileName).toBe('unique_route_name.json');
    expect(trip(app).etag).toBeUndefined();
    // Selecting an imported trip persists its pointer; renaming it does not yet move it.
    expect(localStorage.getItem('copilot_active_file')).toBe('collision_route.json');
    expect(new URL(window.location.href).searchParams.get('route')).toBe('collision_route.json');

    // Subsequent save succeeds under the new filename with ifNoneMatch: '*'
    api.saveItinerary.mockResolvedValueOnce({
      success: true,
      fileName: 'unique_route_name.json',
      etag: '"etag-safe-new"',
    });

    await act(async () => {
      await header(app).onSaveTrip();
    });

    expect(api.saveItinerary).toHaveBeenLastCalledWith(
      'unique_route_name.json',
      expect.any(Object),
      { ifNoneMatch: '*' }
    );
    expect(trip(app).etag).toBe('"etag-safe-new"');
    expect(header(app).isDirty).toBe(false);
    expect(localStorage.getItem('copilot_active_file')).toBe('unique_route_name.json');
    expect(new URL(window.location.href).searchParams.get('route')).toBe('unique_route_name.json');

    // If a trip with an etag is renamed without a conflict, existing filename is preserved
    await act(async () => {
      header(app).onRenameTrip('Renamed Title Keep File');
    });
    expect(trip(app).tripName).toBe('Renamed Title Keep File');
    expect(trip(app).fileName).toBe('unique_route_name.json');
    expect(trip(app).etag).toBe('"etag-safe-new"');
  });

  it('does not flag replacement trip B as conflicted when a prior save of trip A fails with 412', async () => {
    let failTripA!: (err: unknown) => void;
    api.saveItinerary.mockReturnValue(new Promise((_resolve, reject) => { failTripA = reject; }));
    const app = await mountApp();

    let saving!: Promise<void>;
    await act(async () => { saving = header(app).onSaveTrip(); });

    // Switch to Trip B with valid ETag
    const tripB: ParsedTrip = {
      tripName: 'Trip B Clean',
      fileName: 'trip_b.json',
      etag: '"etag-b-valid"',
      isMultiDay: false,
      days: [
        {
          dayNumber: 1,
          date: '2026-10-15',
          title: 'Trip B Clean',
          departureTime: '10:00:00',
          timezone: 'America/Phoenix',
          waypoints: points(1),
        },
      ],
    };
    await act(async () => { selectTrip(app, tripB); });

    // Trip A's save now fails with 412
    await act(async () => {
      failTripA(new api.ApiError('Precondition Failed', 412));
      await saving;
    });

    // Alert should NOT be called for Trip B
    expect(window.alert).not.toHaveBeenCalled();

    // Renaming Trip B must NOT treat Trip B as conflicted (must keep trip_b.json and etag)
    await act(async () => {
      header(app).onRenameTrip('Trip B Renamed Clean');
    });

    expect(trip(app).tripName).toBe('Trip B Renamed Clean');
    expect(trip(app).fileName).toBe('trip_b.json');
    expect(trip(app).etag).toBe('"etag-b-valid"');
  });

  it('does not restore old filename when a new trip is renamed while its initial save is pending', async () => {
    let finishSave!: (val: { success: boolean; fileName: string; etag: string }) => void;
    api.saveItinerary.mockReturnValue(new Promise((resolve) => { finishSave = resolve; }));
    const app = await mountApp();

    const freshTrip: ParsedTrip = {
      tripName: 'Initial Fresh Trip',
      fileName: undefined,
      etag: undefined,
      isMultiDay: false,
      days: [
        {
          dayNumber: 1,
          date: '2026-10-10',
          title: 'Initial Fresh Trip',
          departureTime: '09:00:00',
          timezone: 'America/Phoenix',
          waypoints: points(1),
        },
      ],
    };
    await act(async () => { selectTrip(app, freshTrip); });

    let saving!: Promise<void>;
    await act(async () => { saving = header(app).onSaveTrip(); });

    // While save of initial_fresh_trip.json is pending, user renames the trip
    await act(async () => {
      header(app).onRenameTrip('Renamed Fresh Target');
    });

    expect(trip(app).tripName).toBe('Renamed Fresh Target');
    expect(trip(app).fileName).toBe('renamed_fresh_target.json');

    // The initial save of initial_fresh_trip.json resolves
    await act(async () => {
      finishSave({ success: true, fileName: 'initial_fresh_trip.json', etag: '"etag-old-target"' });
      await saving;
    });

    // The active trip must NOT have been restored to initial_fresh_trip.json
    expect(trip(app).tripName).toBe('Renamed Fresh Target');
    expect(trip(app).fileName).toBe('renamed_fresh_target.json');
    expect(trip(app).etag).toBeUndefined();
  });

  it('resets isSaving to false upon completion when saving a trip and changing revision while save is pending', async () => {
    let finishSave!: (val: { success: boolean; fileName: string; etag: string }) => void;
    api.saveItinerary.mockReturnValue(new Promise((resolve) => { finishSave = resolve; }));
    const app = await mountApp();

    expect(header(app).isSaving).toBe(false);

    let saving!: Promise<void>;
    await act(async () => {
      saving = header(app).onSaveTrip();
    });

    expect(header(app).isSaving).toBe(true);

    // Rename trip while save is in-flight, which bumps tripRevisionRef
    await act(async () => {
      header(app).onRenameTrip('Renamed During Save');
    });

    // In-flight save finishes
    await act(async () => {
      finishSave({ success: true, fileName: 'scheduling_tests.json', etag: '"new-etag"' });
      await saving;
    });

    // isSaving must be reset to false so Save does not remain permanently disabled
    expect(header(app).isSaving).toBe(false);
  });

  it('Bug A: marks created or imported trip as unsaved (isDirty true) until first successful save', async () => {
    const app = await mountApp();
    expect(header(app).isDirty).toBe(false);

    const newTrip: ParsedTrip = {
      tripName: 'Brand New Trip',
      isMultiDay: false,
      dates: { start: '2026-10-10', end: '2026-10-10' },
      days: [
        {
          dayNumber: 1,
          date: '2026-10-10',
          title: 'Day 1',
          departureTime: '09:00:00',
          timezone: 'America/Phoenix',
          waypoints: points(1),
        },
      ],
    };

    // Selecting trip with { unsaved: true }
    await act(async () => {
      selectTrip(app, newTrip, { unsaved: true });
    });

    // Must be dirty immediately upon selection of unsaved trip
    expect(header(app).isDirty).toBe(true);

    // Save fails with 500 error
    api.saveItinerary.mockRejectedValueOnce(new Error('Network error'));
    await act(async () => {
      await header(app).onSaveTrip();
    });

    // Must still be dirty after failed save
    expect(header(app).isDirty).toBe(true);

    // Save succeeds
    api.saveItinerary.mockResolvedValueOnce({ success: true, fileName: 'brand_new_trip.json' });
    await act(async () => {
      await header(app).onSaveTrip();
    });

    // Now it should be clean
    expect(header(app).isDirty).toBe(false);

    // Workspace load (without unsaved option) should not be dirty
    const workspaceTrip = parseItineraryJson(fixture(), 'workspace.json');
    await act(async () => {
      selectTrip(app, workspaceTrip);
    });
    expect(header(app).isDirty).toBe(false);
  });

  it('Bug B: retains active multi-day trip and selection when an initialization retry fails after initial load', async () => {
    const app = await mountApp();

    // Select Day 2 (index 1) of the 2-day fixture
    await act(async () => {
      tabs(app).onSelectDay(1);
    });

    expect(trip(app).days.length).toBe(2);
    expect(trip(app).tripName).toBe('Scheduling tests');

    // Simulate transition to unauthenticated state via logout
    await act(async () => {
      await header(app).onLogout();
    });

    // AuthGateScreen should now be visible
    const gateScreen = app.root.findByType(AuthGateScreen);
    expect(gateScreen).toBeDefined();

    // Configure auth status to succeed on retry, but both itinerary requests fail
    api.fetchAuthStatus.mockResolvedValue({
      authEnabled: true,
      authenticated: true,
      authorized: true,
      user: { sub: 'driver-1', email: 'pilot@example.com', name: 'Pilot' },
    });
    api.fetchItinerary.mockRejectedValue(new Error('500 Itinerary Server Down'));

    // Trigger retryInitialization via onRetry
    await act(async () => {
      await gateScreen.props.onRetry();
    });

    // Active trip MUST NOT have been replaced by the placeholder trip
    expect(trip(app).days.length).toBe(2);
    expect(trip(app).tripName).toBe('Scheduling tests');
  });

  it('surfaces a retry screen without an active trip when startup load fails', async () => {
    stubWindowLocation('?route=missing.json&day=5');
    api.fetchItinerary.mockRejectedValue(new Error('Failed to load any itinerary'));

    const app = await mountApp();

    expect(textOf(app.root)).toContain('Unable to load your routes');
    expect(textOf(app.root)).toContain('Failed to load any itinerary');
    const retry = app.root.findAllByType('button').find((button) => textOf(button) === 'Retry');
    expect(retry).toBeDefined();
    expect(app.root.findAllByType('button').some((button) => textOf(button) === 'Start a new route')).toBe(true);
    expect(app.root.findAllByType('test-selector')).toHaveLength(0);
    expect(app.root.findAllByType('test-header')).toHaveLength(0);

    api.fetchItinerary.mockResolvedValue(fixture());
    await act(async () => {
      (retry!.props as { onClick: () => void }).onClick();
    });

    expect(trip(app).tripName).toBe('Scheduling tests');
    expect(header(app).onSaveTrip).toBeDefined();
    expect(header(app).isDirty).toBe(false);
  });

  it('escapes the startup error screen through Start a new route', async () => {
    stubWindowLocation('?route=missing.json&day=0');
    api.fetchItinerary.mockRejectedValue(new Error('Network down'));

    const app = await mountApp();

    const startNew = app.root
      .findAllByType('button')
      .find((button) => textOf(button) === 'Start a new route');
    expect(startNew).toBeDefined();

    await act(async () => {
      (startNew!.props as { onClick: () => void }).onClick();
    });

    expect(selectorProps(app).isOpen).toBe(true);
    expect(selectorProps(app).dismissible).toBe(false);
    expect(textOf(app.root)).not.toContain('Network down');
    expect(api.fetchItinerary).toHaveBeenCalledTimes(1);
  });

  it('opens the route selector without an error screen when the active route is missing', async () => {
    stubWindowLocation('?route=missing.json&day=5');
    api.fetchItinerary.mockRejectedValue(new api.ApiError('not found', 404));

    const app = await mountApp();

    expect(selectorProps(app).isOpen).toBe(true);
    expect(localStorage.getItem('copilot_active_file')).toBeNull();
    expect(trip(app).tripName).toBe('Untitled Road Trip');
    expect(textOf(app.root)).not.toContain('not found');
    expect(app.root.findAllByType('button').some((button) => textOf(button) === 'Retry')).toBe(false);
  });

  it('opens the chooser without fetching when there is no active route', async () => {
    stubWindowLocation('');

    const app = await mountApp();

    expect(selectorProps(app).isOpen).toBe(true);
    expect(selectorProps(app).dismissible).toBe(false);
    expect(header(app).onSaveTrip).toBeUndefined();
    expect(header(app).isDirty).toBe(false);
    expect(trip(app).tripName).toBe('Untitled Road Trip');
    expect(trip(app).days[0].waypoints).toHaveLength(0);
    expect(api.fetchItinerary).not.toHaveBeenCalled();
  });

  it('starts the sample as an unsaved ad-hoc trip without persisting a pointer', async () => {
    stubWindowLocation('');
    const app = await mountApp();

    await act(async () => {
      selectTrip(app, createSampleTrip(), { unsaved: true });
    });

    expect(trip(app).tripName).toBe('Scenic Southwest: Phoenix to Flagstaff');
    expect(trip(app).fileName).toBeUndefined();
    expect(trip(app).days[0].waypoints).toHaveLength(4);
    expect(header(app).schedulingMode).toBe('adhoc');
    expect(header(app).isDirty).toBe(true);
    expect(header(app).onSaveTrip).toBeDefined();
    expect(localStorage.getItem('copilot_active_file')).toBeNull();
    expect(new URL(window.location.href).searchParams.get('route')).toBeNull();
  });

  it('saves the sample as a new ad-hoc file derived from its name', async () => {
    api.fetchRoute.mockRejectedValue(new Error('Router unavailable'));
    stubWindowLocation('');
    const app = await mountApp();

    await act(async () => {
      selectTrip(app, createSampleTrip(), { unsaved: true });
    });
    await act(async () => {
      await header(app).onSaveTrip();
    });

    expect(api.saveItinerary).toHaveBeenLastCalledWith(
      'scenic_southwest_phoenix_to_flagstaff.json',
      expect.any(Object),
      { ifNoneMatch: '*' }
    );
    const output = saved<SingleRouteItineraryV2>();
    expect(output.scheduling_mode).toBe('adhoc');
    expect(output.date).toBeUndefined();
    expect(output.dates).toBeUndefined();
    expect(output.checkpoints.map((checkpoint) => checkpoint.offset_minutes_from_start)).toEqual([0, 120, 165, 210]);
    expect(output.checkpoints.every((checkpoint) => checkpoint.target_time === undefined)).toBe(true);
    expect(localStorage.getItem('copilot_active_file')).toBe('scenic_southwest_phoenix_to_flagstaff.json');
  });

  it('returns to the chooser after deleting the active route without loading a sample', async () => {
    const app = await mountApp();
    expect(trip(app).tripName).toBe('Scheduling tests');
    const startedGeneration = selectorProps(app).getTripGeneration?.();

    await act(async () => {
      await selectorProps(app).onDeleteTrip!('test.json', startedGeneration);
    });

    expect(selectorProps(app).isOpen).toBe(true);
    expect(selectorProps(app).dismissible).toBe(false);
    expect(trip(app).tripName).toBe('Untitled Road Trip');
    expect(trip(app).days[0].waypoints).toHaveLength(0);
    expect(header(app).isDirty).toBe(false);
    expect(localStorage.getItem('copilot_active_file')).toBeNull();
    expect(new URL(window.location.href).searchParams.get('route')).toBeNull();
    expect(api.fetchItinerary).toHaveBeenCalledTimes(1);
    expect(api.fetchItinerary).toHaveBeenNthCalledWith(1, 'test.json');
  });

  it('does not persist an active-file pointer for an unsaved new route', async () => {
    const app = await mountApp();
    expect(localStorage.getItem('copilot_active_file')).toBe('test.json');

    const blankTrip: ParsedTrip = {
      tripName: 'Unsaved New Route',
      isMultiDay: false,
      days: [
        {
          dayNumber: 1,
          date: '2026-10-10',
          title: 'Unsaved New Route',
          departureTime: '09:00:00',
          timezone: 'America/Phoenix',
          waypoints: points(1),
        },
      ],
    };

    await act(async () => {
      selectTrip(app, blankTrip, { unsaved: true });
    });

    expect(localStorage.getItem('copilot_active_file')).toBeNull();
    expect(new URL(window.location.href).searchParams.get('route')).toBeNull();
    expect(trip(app).fileName).toBeUndefined();
    expect(header(app).isDirty).toBe(true);

    await act(async () => {
      header(app).onRenameTrip('Renamed Unsaved Route');
    });

    expect(trip(app).fileName).toBe('renamed_unsaved_route.json');
    expect(localStorage.getItem('copilot_active_file')).toBeNull();
    expect(new URL(window.location.href).searchParams.get('route')).toBeNull();
  });

  it('Bug C: preserves pending routing results for inactive days when renaming an unsaved trip with new file target', async () => {
    let releaseDay2Route!: (val: RouteResponse) => void;
    api.fetchRoute.mockImplementation((coords: Array<{ lat: number; lng: number }>) => {
      // Coords for day 2 has lat base 33.6
      if (coords[0]?.lat > 33.5) {
        return new Promise<RouteResponse>((resolve) => {
          releaseDay2Route = resolve;
        });
      }
      return Promise.resolve(roadResponse([3600, 1800]));
    });

    const app = await mountApp();

    const multiDayTrip: ParsedTrip = {
      tripName: 'Unsaved Multi-Day',
      isMultiDay: true,
      dates: { start: '2026-10-09', end: '2026-10-10' },
      days: [
        {
          dayNumber: 1,
          date: '2026-10-09',
          title: 'Day 1',
          departureTime: '09:00:00',
          timezone: 'America/Phoenix',
          waypoints: points(1),
        },
        {
          dayNumber: 2,
          date: '2026-10-10',
          title: 'Day 2',
          departureTime: '09:00:00',
          timezone: 'America/Phoenix',
          waypoints: points(2),
        },
      ],
    };

    await act(async () => {
      selectTrip(app, multiDayTrip, { unsaved: true });
    });

    // Switch to Day 2 to start routing for Day 2
    await act(async () => {
      tabs(app).onSelectDay(1);
    });

    // Switch back to Day 1 so Day 2 is inactive while Day 2 route is pending
    await act(async () => {
      tabs(app).onSelectDay(0);
    });

    // While Day 2 routing is pending, user renames the trip (triggers isNewFileTarget since fileName is undefined)
    await act(async () => {
      header(app).onRenameTrip('Renamed Target Trip');
    });

    // Day 2 route now resolves
    await act(async () => {
      releaseDay2Route(roadResponse([3600, 1800]));
    });

    // Save trip
    await act(async () => {
      await header(app).onSaveTrip();
    });

    // Saved payload must include target_time for Day 2 (inactive day)
    expect(saved().days[1].checkpoints[2].target_time).toBe('11:00:00');
  });

  it('Defect 2: does not overwrite trip B when active trip A is deleted with deferred DELETE response and trip B is selected and edited in-flight', async () => {
    const app = await mountApp();

    expect(trip(app).tripName).toBe('Scheduling tests');

    // Capture onDeleteTrip and starting generation at initiation of delete (as RouteSelectorModal does)
    const onDeleteTrip = selectorProps(app).onDeleteTrip!;
    const startedGen = selectorProps(app).getTripGeneration ? selectorProps(app).getTripGeneration() : undefined;

    // While DELETE is in flight, user selects trip B and edits it
    const tripB: ParsedTrip = {
      tripName: 'Trip B Original',
      fileName: 'trip_b.json',
      isMultiDay: false,
      days: [
        {
          dayNumber: 1,
          date: '2026-10-10',
          title: 'Day 1',
          departureTime: '09:00:00',
          timezone: 'America/Phoenix',
          waypoints: [],
        },
      ],
    };

    await act(async () => {
      selectTrip(app, tripB);
    });

    await act(async () => {
      header(app).onRenameTrip('Trip B Edited During Delete');
    });

    expect(trip(app).tripName).toBe('Trip B Edited During Delete');

    // DELETE finishes and calls onDeleteTrip with the generation captured at start
    await act(async () => {
      await onDeleteTrip('test.json', startedGen);
    });

    // Trip B and its edit MUST be retained!
    expect(trip(app).tripName).toBe('Trip B Edited During Delete');
    expect(trip(app).fileName).toBe('trip_b.json');
  });
});
