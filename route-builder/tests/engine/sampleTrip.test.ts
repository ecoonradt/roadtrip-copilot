import { describe, it, expect } from 'vitest';
import { createSampleTrip } from '../../src/engine/sampleTrip';
import { parseItineraryJson, serializeTripToItineraryJson } from '../../src/engine/itineraryParser';

function asRecordList(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an array`);
  }
  return (value as unknown[]).map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Expected ${label} entries to be objects`);
    }
    return entry as Record<string, unknown>;
  });
}

describe('createSampleTrip (relative ad-hoc sample route)', () => {
  it('returns a fresh object graph on every call', () => {
    const first = createSampleTrip();
    const originalName = first.days[0].waypoints[0].name;

    first.days[0].waypoints[0].name = 'MUTATED';
    first.days[0].waypoints[0].notification = undefined;
    first.days[0].waypoints.push(first.days[0].waypoints[0]);

    expect(first.days[0].waypoints[0].name).toBe('MUTATED');

    const second = createSampleTrip();
    expect(second.days[0].waypoints[0].name).toBe(originalName);
    expect(second.days[0].waypoints).toHaveLength(4);
    expect(second.days[0].waypoints[0].notification?.title).toBe('Road Trip Begins!');
    expect(second).not.toBe(first);
    expect(second.days).not.toBe(first.days);
    expect(second.days[0].waypoints).not.toBe(first.days[0].waypoints);
  });

  it('has a single-day ad-hoc shape with relative offsets only', () => {
    const trip = createSampleTrip();

    expect(trip.isMultiDay).toBe(false);
    expect(trip.isAdHoc).toBe(true);
    expect(trip.dates).toBeUndefined();
    expect(trip.days).toHaveLength(1);

    const day = trip.days[0];
    expect(day).toBeDefined();
    expect(day.timezone).toBe('America/Phoenix');
    expect(day.waypoints).toHaveLength(4);

    expect(day.waypoints.map((w) => w.offset_minutes_from_start)).toEqual([0, 120, 165, 210]);
    for (const waypoint of day.waypoints) {
      expect(waypoint.target_time).toBeUndefined();
      expect(waypoint.timezone).toBe('America/Phoenix');
      expect(typeof waypoint.dwell_minutes).toBe('number');
      expect(typeof waypoint.trigger_radius_miles).toBe('number');
      expect(waypoint.notification).toBeDefined();
    }
  });

  it('preserves driver-facing notification copy on all four stops', () => {
    const trip = createSampleTrip();
    const waypoints = trip.days[0].waypoints;

    expect(waypoints.map((w) => w.notification?.title)).toEqual([
      'Road Trip Begins!',
      'Approaching Sedona Red Rocks',
      'Oak Creek Canyon Switchbacks',
      'Arrival in Flagstaff',
    ]);

    for (const waypoint of waypoints) {
      const notification = waypoint.notification;
      expect(notification).toBeDefined();
      expect(typeof notification?.title).toBe('string');
      expect((notification?.title ?? '').length).toBeGreaterThan(0);
      expect(typeof notification?.speech).toBe('string');
      expect((notification?.speech ?? '').length).toBeGreaterThan(0);
    }
  });

  it('survives a V2 serializer round-trip as an ad-hoc relative trip', () => {
    const exported = serializeTripToItineraryJson(createSampleTrip('2026-10-22'));

    expect('date' in exported).toBe(false);
    expect('dates' in exported).toBe(false);

    const metadata = exported.metadata as { version: string };
    expect(typeof metadata).toBe('object');
    expect(metadata.version).toBe('2.0.0');

    const checkpoints = asRecordList(exported.checkpoints, 'checkpoints');
    expect(checkpoints).toHaveLength(4);
    for (const checkpoint of checkpoints) {
      expect(typeof checkpoint.offset_minutes_from_start).toBe('number');
      expect('target_time' in checkpoint).toBe(false);
      expect(checkpoint.target_time).toBeUndefined();
    }
    expect(checkpoints.map((cp) => cp.offset_minutes_from_start)).toEqual([0, 120, 165, 210]);

    const parsed = parseItineraryJson(exported);
    expect(parsed.isAdHoc).toBe(true);
    expect(parsed.dates).toBeUndefined();
    expect(parsed.days).toHaveLength(1);
    expect(parsed.days[0].waypoints.map((w) => w.offset_minutes_from_start)).toEqual([
      0, 120, 165, 210,
    ]);
    expect(parsed.days[0].timezone).toBe('America/Phoenix');
  });

  it('is deterministic for an explicit date', () => {
    expect(createSampleTrip('2026-10-22').days[0].date).toBe('2026-10-22');
    expect(createSampleTrip('2026-10-22').days[0].date).toBe(
      createSampleTrip('2026-10-22').days[0].date
    );
  });
});
