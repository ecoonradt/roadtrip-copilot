import { describe, it, expect } from 'vitest';
import {
  parseItineraryJson,
  serializeTripToItineraryJson,
  inferWaypointType,
} from '../../src/engine/itineraryParser';

describe('Itinerary Parser & Multi-Day Engine (itineraryParser.ts)', () => {
  it('keeps explicit single-day scheduling intent authoritative over legacy clock inference', () => {
    const checkpoints = [
      { id: 'origin', name: 'Origin', lat: 33.1, lng: -112, offset_minutes_from_start: 0 },
      { id: 'dest', name: 'Destination', lat: 33.2, lng: -112, offset_minutes_from_start: 60 },
    ];
    const fixed = parseItineraryJson({ trip_name: 'Catch-Up draft', date: '2026-10-09', departure_time: '15:00:00', scheduling_mode: 'backward', target_arrival_time: '16:00:00', checkpoints });
    expect(fixed.isAdHoc).toBe(false);
    expect(fixed.days[0].schedulingMode).toBe('backward');
    expect(fixed.days[0].departureTime).toBe('15:00:00');
    expect(serializeTripToItineraryJson(fixed, { preserveTargetTimes: true }).date).toBe('2026-10-09');
    const relative = parseItineraryJson({ trip_name: 'Relative', date: '2026-10-09', scheduling_mode: 'adhoc', checkpoints });
    expect(relative.isAdHoc).toBe(true);
    expect(serializeTripToItineraryJson(relative, { preserveTargetTimes: true }).date).toBeUndefined();
  });

  it('correctly parses multi-day itinerary with 4 days and preserves metadata', () => {
    const multiDayJson = {
      trip_name: 'Phoenix to Albuquerque Road Trip',
      dates: { start: '2026-10-09', end: '2026-10-12' },
      days: [
        {
          day: 1,
          date: '2026-10-09',
          timezone: 'America/Phoenix',
          title: 'Red Rock Entry & Oak Creek Canyon',
          checkpoints: [
            {
              id: 'phx_rental',
              name: 'PHX Rental Car Facility',
              target_time: '14:30:00',
              lat: 33.4357,
              lng: -112.0152,
              trigger_radius_miles: 0.5,
              notification: {
                title: 'Road Trip Begins!',
                speech: 'Welcome to Arizona.',
              },
            },
            {
              id: 'sedona_bell_rock',
              name: 'Sedona Red Rock Vistas',
              target_time: '16:30:00',
              lat: 34.801,
              lng: -111.7645,
              trigger_radius_miles: 3.0,
            },
          ],
        },
        {
          day: 2,
          date: '2026-10-10',
          timezone: 'America/Phoenix',
          title: 'Navajo Nation & Shiprock',
          checkpoints: [
            {
              id: 'flagstaff_depart',
              name: 'Little America Hotel Flagstaff',
              target_time: '08:30:00',
              lat: 35.1878,
              lng: -111.6152,
            },
          ],
        },
      ],
    };

    const trip = parseItineraryJson(multiDayJson, 'itinerary.json');

    expect(trip.tripName).toBe('Phoenix to Albuquerque Road Trip');
    expect(trip.isMultiDay).toBe(true);
    expect(trip.days).toHaveLength(2);

    // Day 1 Checks
    expect(trip.days[0].dayNumber).toBe(1);
    expect(trip.days[0].date).toBe('2026-10-09');
    expect(trip.days[0].title).toBe('Red Rock Entry & Oak Creek Canyon');
    expect(trip.days[0].departureTime).toBe('14:30:00');
    expect(trip.days[0].waypoints).toHaveLength(2);
    expect(trip.days[0].waypoints[0].type).toBe('origin');
    expect(trip.days[0].waypoints[0].notification?.title).toBe('Road Trip Begins!');
    expect(trip.days[0].waypoints[1].type).toBe('scenic_pull_off');

    // Day 2 Checks
    expect(trip.days[1].dayNumber).toBe(2);
    expect(trip.days[1].date).toBe('2026-10-10');
    expect(trip.days[1].title).toBe('Navajo Nation & Shiprock');
    expect(trip.days[1].departureTime).toBe('08:30:00');
    expect(trip.days[1].waypoints).toHaveLength(1);
    expect(trip.days[1].waypoints[0].type).toBe('origin');
  });

  it('correctly parses single-route itineraries (e.g. test_itinerary.json)', () => {
    const singleJson = {
      trip_name: 'Test Run: Albany to Nassau',
      date: '2026-09-06',
      timezone: 'America/New_York',
      checkpoints: [
        {
          id: 'depart_Albany',
          name: 'Departure: Empire State Plaza',
          lat: 42.65260,
          lng: -73.75620,
          trigger_radius_miles: 0.3,
        },
        {
          id: 'dest_nassau',
          name: 'Arrival: Proctors Theatre',
          lat: 42.81450,
          lng: -73.94050,
          trigger_radius_miles: 0.5,
        },
      ],
    };

    const trip = parseItineraryJson(singleJson, 'test_itinerary.json');

    expect(trip.tripName).toBe('Test Run: Albany to Nassau');
    expect(trip.isMultiDay).toBe(false);
    expect(trip.days).toHaveLength(1);
    expect(trip.days[0].dayNumber).toBe(1);
    expect(trip.days[0].date).toBe('2026-09-06');
    expect(trip.days[0].waypoints).toHaveLength(2);
    expect(trip.days[0].waypoints[0].type).toBe('origin');
    expect(trip.days[0].waypoints[1].type).toBe('destination');
  });

  it('infers waypoint types accurately from name and position', () => {
    expect(inferWaypointType('Starting Point', 'id1', 0, 4)).toBe('origin');
    expect(inferWaypointType('Hampton Inn Flagstaff', 'id2', 1, 4)).toBe('lodging');
    expect(inferWaypointType('Lumberyard Brewing Company', 'id3', 2, 4)).toBe('meal');
    expect(inferWaypointType('Shell Gas Station', 'id4', 2, 4)).toBe('fuel');
    expect(inferWaypointType('Safeway Supermarket', 'id5', 2, 5)).toBe('stop');
    expect(inferWaypointType("Trader Joe's Grocery", 'id6', 2, 5)).toBe('stop');
    expect(inferWaypointType('Walgreens Pharmacy', 'id7', 2, 5)).toBe('stop');
    expect(inferWaypointType('Final Dropoff', 'id8', 4, 5)).toBe('destination');
  });

  it('correctly handles stop and general_stop types in parsed itineraries', () => {
    const raw = {
      trip_name: 'Errand Route',
      checkpoints: [
        { id: '1', name: 'Start', type: 'origin', lat: 34.0, lng: -111.0 },
        {
          id: '2',
          name: 'Whole Foods Market',
          type: 'stop',
          lat: 34.1,
          lng: -111.1,
          dwell_minutes: 25,
          is_route_anchor: true,
          notification: { title: 'Whole Foods', message: 'Snacks', speech: 'Buy snacks' },
        },
        { id: '3', name: 'Target Errand', type: 'general_stop', lat: 34.2, lng: -111.2 },
        { id: '4', name: 'End', type: 'destination', lat: 34.3, lng: -111.3 },
      ],
    };
    const trip = parseItineraryJson(raw);
    expect(trip.days[0].waypoints[1].type).toBe('stop');
    expect(trip.days[0].waypoints[1].dwell_minutes).toBe(25);
    expect(trip.days[0].waypoints[1].notification).toBeUndefined();
    expect(trip.days[0].waypoints[1].is_route_anchor).toBe(false);
    expect(trip.days[0].waypoints[2].type).toBe('stop'); // normalized from general_stop
    expect(trip.days[0].waypoints[2].dwell_minutes).toBe(20); // default dwell
  });

  it('serializes ParsedTrip back to valid JSON round-trip', () => {
    const sample = {
      trip_name: 'Round Trip Test',
      dates: { start: '2026-10-09', end: '2026-10-10' },
      days: [
        {
          day: 1,
          date: '2026-10-09',
          title: 'Day 1',
          checkpoints: [
            { id: '1', name: 'Stop 1', lat: 34.1234567, lng: -111.1234567 },
          ],
        },
      ],
    };

    const trip = parseItineraryJson(sample);
    const serialized = serializeTripToItineraryJson(trip);

    expect(serialized.trip_name).toBe('Round Trip Test');
    expect(serialized.google_maps_url).toContain('https://www.google.com/maps/dir/?api=1');
    expect(Array.isArray((serialized as { days: unknown[] }).days)).toBe(true);
    const serializedDays = (serialized as { days: Array<{ checkpoints: Array<{ lat: number }>; google_maps_url?: string }> }).days;
    expect(serializedDays[0].checkpoints[0].lat).toBe(34.123457);
    expect(serializedDays[0].google_maps_url).toBe(serialized.google_maps_url);
  });

  it('preserves address, google_place_id, is_route_anchor, notes, and approachHighway when serializing', () => {
    const sample = {
      trip_name: 'Place ID Preservation Test',
      days: [
        {
          day: 1,
          date: '2026-10-09',
          title: 'Day 1',
          checkpoints: [
            {
              id: 'hotel_stop',
              name: 'Little America Hotel',
              lat: 35.1901,
              lng: -111.6207,
              address: '2515 E Butler Ave, Flagstaff, AZ 86004',
              google_place_id: 'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q',
              is_route_anchor: false,
              approachHighway: 'I-40 East',
              notes: 'Paved lot, EV charging available',
            },
            {
              id: 'anchor_pass',
              name: 'Scenic Pass Anchor',
              lat: 34.8,
              lng: -111.7,
              is_route_anchor: true,
            },
          ],
        },
      ],
    };

    const trip = parseItineraryJson(sample);
    const serialized = serializeTripToItineraryJson(trip);

    const serializedDays = (serialized as { days: Array<{ checkpoints: Array<Record<string, unknown>> }> }).days;
    const cp1 = serializedDays[0].checkpoints[0];
    const cp2 = serializedDays[0].checkpoints[1];

    expect(cp1.address).toBe('2515 E Butler Ave, Flagstaff, AZ 86004');
    expect(cp1.google_place_id).toBe('ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q');
    expect(cp1.is_route_anchor).toBe(false);
    expect(cp1.approachHighway).toBe('I-40 East');
    expect(cp1.notes).toBe('Paved lot, EV charging available');

    expect(cp2.is_route_anchor).toBe(true);
  });

  it('normalizes overnight lodging and destination stop dwell_minutes to 0 on parse and serialization', () => {
    const sample = {
      trip_name: 'Overnight Dwell Test',
      days: [
        {
          day: 1,
          date: '2026-10-09',
          title: 'Day 1',
          checkpoints: [
            { id: 'origin', name: 'Departure Point', lat: 33.4, lng: -112.0, type: 'origin', dwell_minutes: 0 },
            { id: 'mid', name: 'Lunch Stop', lat: 34.5, lng: -111.8, type: 'meal', dwell_minutes: 45 },
            { id: 'hotel', name: 'Little America Flagstaff', lat: 35.1, lng: -111.6, type: 'lodging', dwell_minutes: 60 },
          ],
        },
      ],
    };

    const trip = parseItineraryJson(sample);
    expect(trip.days[0].waypoints[0].dwell_minutes).toBe(0);
    expect(trip.days[0].waypoints[1].dwell_minutes).toBe(45);
    expect(trip.days[0].waypoints[2].dwell_minutes).toBe(0); // Normalized to 0

    const serialized = serializeTripToItineraryJson(trip);
    const serializedDays = (serialized as { days: Array<{ checkpoints: Array<Record<string, unknown>> }> }).days;
    expect(serializedDays[0].checkpoints[2].dwell_minutes).toBe(0);
  });

  it('automatically purges legacy anchor flags and synchronizes target times on serialization', () => {
    // Simulates the exact Day 1 road trip scenario:
    // Origin, Sedona anchor pass, Switchbacks drive-by, Oak Creek Vista (15m dwell), Little America (lodging)
    const sample = {
      trip_name: 'Auto-Clean & Sync Test',
      days: [
        {
          day: 1,
          date: '2026-10-09',
          title: 'Day 1',
          departure_time: '14:30:00',
          checkpoints: [
            {
              id: 'phx_origin',
              name: 'PHX Rental Car',
              lat: 33.4312,
              lng: -112.0435,
              type: 'origin',
              dwell_minutes: 0,
              is_route_anchor: true, // Legacy error: origin should not be an anchor
            },
            {
              id: 'sedona_anchor',
              name: 'Sedona Red Rocks Vista',
              lat: 34.7802,
              lng: -111.763,
              type: 'scenic_drive_by',
              dwell_minutes: 0,
              is_route_anchor: true, // Legitimate in-transit corridor anchor
            },
            {
              id: 'oak_creek_vista',
              name: 'Oak Creek Vista Overlook',
              lat: 35.0306,
              lng: -111.7335,
              type: 'scenic_pull_off',
              dwell_minutes: 15,
              target_time: '12:00:00', // Stale draft time
              is_route_anchor: true, // Legacy error: physical stop with dwell should not be anchor
            },
            {
              id: 'flagstaff_hotel',
              name: 'Little America Hotel Flagstaff',
              lat: 35.1901,
              lng: -111.6207,
              type: 'lodging',
              dwell_minutes: 0,
              is_route_anchor: true, // Legacy error: destination should not be an anchor
            },
          ],
        },
      ],
    };

    const trip = parseItineraryJson(sample);
    const serialized = serializeTripToItineraryJson(trip);
    const checkpoints = (serialized as { days: Array<{ checkpoints: Array<Record<string, unknown>> }> }).days[0].checkpoints;

    // Origin: anchor stripped, target_time set to departure
    expect(checkpoints[0].is_route_anchor).toBe(false);
    expect(checkpoints[0].target_time).toBe('14:30:00');

    // Sedona Red Rocks (in-transit drive-by): anchor preserved!
    expect(checkpoints[1].is_route_anchor).toBe(true);

    // Oak Creek Vista (physical stop with 15m dwell): anchor stripped, target_time synchronized with afternoon arrival
    expect(checkpoints[2].is_route_anchor).toBe(false);
    expect(checkpoints[2].target_time).not.toBe('12:00:00');
    expect(typeof checkpoints[2].target_time).toBe('string');

    // Little America Hotel (lodging destination): anchor stripped
    expect(checkpoints[3].is_route_anchor).toBe(false);
  });

  it('preserves valid westbound timezone crossing target times on serialization', () => {
    const westDay = {
      day: 1,
      date: '2026-10-09',
      timezone: 'America/Denver',
      title: 'Westbound Border Crossing',
      departure_time: '09:00:00',
      checkpoints: [
        {
          id: 'nm_depart',
          name: 'New Mexico departure',
          lat: 34.18,
          lng: -109.0,
          timezone: 'America/Denver',
          target_time: '09:00:00',
        },
        {
          id: 'az_arrival',
          name: 'Arizona arrival',
          lat: 34.16,
          lng: -109.1,
          timezone: 'America/Phoenix',
          target_time: '08:30:00',
        },
      ],
    };

    const multiTrip = parseItineraryJson({ trip_name: 'Westbound Multi-day', days: [westDay] });
    const serializedMulti = serializeTripToItineraryJson(multiTrip, { preserveTargetTimes: true });
    const multiCps = (serializedMulti as { days: Array<{ checkpoints: Array<{ target_time: string; timezone: string }> }> }).days[0].checkpoints;
    expect(multiCps[1].target_time).toBe('08:30:00');
    expect(multiCps[1].timezone).toBe('America/Phoenix');

    const singleTrip = parseItineraryJson({
      trip_name: 'Westbound Single',
      date: westDay.date,
      timezone: westDay.timezone,
      departure_time: westDay.departure_time,
      checkpoints: westDay.checkpoints,
    });
    const serializedSingle = serializeTripToItineraryJson(singleTrip, { preserveTargetTimes: true });
    const singleCps = (serializedSingle as { checkpoints: Array<{ target_time: string; timezone: string }> }).checkpoints;
    expect(singleCps[1].target_time).toBe('08:30:00');
    expect(singleCps[1].timezone).toBe('America/Phoenix');
  });

  it('treats unrouted new waypoints as drafts without fabricating clamped target times on preserveTargetTimes', () => {
    const tripWithUnrouted = {
      trip_name: 'Draft Stop Test',
      days: [
        {
          day: 1,
          date: '2026-10-09',
          timezone: 'America/Phoenix',
          departure_time: '09:00:00',
          checkpoints: [
            { id: '1', name: 'Stop 1', lat: 34.0, lng: -111.0, target_time: '10:00:00' },
            { id: '2', name: 'Stop 2', lat: 34.1, lng: -111.0, target_time: '11:00:00' },
            { id: '3', name: 'Unrouted Stop', lat: 34.2, lng: -111.0 }, // no target_time
          ],
        },
      ],
    };

    const parsed = parseItineraryJson(tripWithUnrouted);
    const serialized = serializeTripToItineraryJson(parsed, { preserveTargetTimes: true });
    const cps = (serialized as { days: Array<{ checkpoints: Array<{ target_time?: string }> }> }).days[0].checkpoints;
    expect(cps[0].target_time).toBe('10:00:00');
    expect(cps[1].target_time).toBe('11:00:00');
    expect(cps[2].target_time).toBeUndefined();
    expect((cps[2] as { offset_minutes_from_start?: number }).offset_minutes_from_start).toBeUndefined();
  });
});
