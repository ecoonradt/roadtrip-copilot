import { describe, it, expect } from 'vitest';
import {
  parseItineraryJson,
  serializeTripToItineraryJson,
  inferWaypointType,
} from '../../src/engine/itineraryParser';

describe('Itinerary Parser & Multi-Day Engine (itineraryParser.ts)', () => {
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
    expect(inferWaypointType('Final Dropoff', 'id5', 3, 4)).toBe('destination');
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
    expect(Array.isArray((serialized as { days: unknown[] }).days)).toBe(true);
    const serializedDays = (serialized as { days: Array<{ checkpoints: Array<{ lat: number }> }> }).days;
    expect(serializedDays[0].checkpoints[0].lat).toBe(34.123457);
  });
});
