import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatMultiDayItinerary,
  formatSingleRouteItinerary,
  formatCheckpointV2,
  normalizeCoordinate,
  normalizeTriggerRadius,
  exportItineraryToJson,
  downloadItineraryJson,
} from '../../src/engine/export';
import type { Waypoint } from '../../src/types/routing';
import type { ScheduledStop } from '../../src/engine/types';

describe('Itinerary V2 Exporter Engine (export.ts)', () => {
  const sampleWaypoints: Waypoint[] = [
    {
      id: 'wp_phx',
      name: 'PHX Sky Harbor',
      type: 'origin',
      lat: 33.435712345,
      lng: -112.015298765,
      target_time: '14:30:00',
      dwell_minutes: 0,
      trigger_radius_miles: 0.5,
      notification: {
        title: 'Road Trip Begins!',
        message: 'Departing PHX via I-17 N towards Sedona.',
        speech: 'Welcome to Arizona. We are departing Phoenix heading north on I-17 toward Sedona.',
      },
    },
    {
      id: 'wp_sedona',
      name: 'Sedona Red Rock Vistas',
      type: 'scenic_pull_off',
      lat: 34.801045,
      lng: -111.764512,
      target_time: '16:30:00',
      dwell_minutes: 30,
      trigger_radius_miles: 3.0,
      notification: {
        title: 'Approaching Sedona',
        message: 'Target arrival: 4:30 PM.',
        speech: 'Approaching Sedona on Highway 179.',
      },
    },
    {
      id: 'wp_flagstaff',
      name: 'Little America Flagstaff',
      type: 'lodging',
      lat: 35.1878,
      lng: -111.6152,
      target_time: '18:15:00',
      dwell_minutes: 0,
      trigger_radius_miles: 0.5,
    },
  ];

  describe('Coordinate & Radius Normalization', () => {
    it('normalizes coordinates to 6 decimal places', () => {
      expect(normalizeCoordinate(33.435712345)).toBe(33.435712);
      expect(normalizeCoordinate(-112.015298765)).toBe(-112.015299);
      expect(normalizeCoordinate(34.8)).toBe(34.8);
    });

    it('clamps trigger radius to [0.3, 6.0] miles with 1 decimal precision', () => {
      expect(normalizeTriggerRadius(0.1)).toBe(0.3);
      expect(normalizeTriggerRadius(8.5)).toBe(6.0);
      expect(normalizeTriggerRadius(2.45)).toBe(2.5);
      expect(normalizeTriggerRadius(undefined)).toBe(0.5);
    });
  });

  describe('formatCheckpointV2', () => {
    it('correctly maps all checkpoint fields and notification', () => {
      const cp = formatCheckpointV2(sampleWaypoints[0]);
      expect(cp.id).toBe('wp_phx');
      expect(cp.name).toBe('PHX Sky Harbor');
      expect(cp.type).toBe('origin');
      expect(cp.lat).toBe(33.435712);
      expect(cp.lng).toBe(-112.015299);
      expect(cp.dwell_minutes).toBe(0);
      expect(cp.trigger_radius_miles).toBe(0.5);
      expect(cp.target_time).toBe('14:30:00');
      expect(cp.notification).toEqual({
        title: 'Road Trip Begins!',
        message: 'Departing PHX via I-17 N towards Sedona.',
        speech: 'Welcome to Arizona. We are departing Phoenix heading north on I-17 toward Sedona.',
      });
    });

    it('omits notification object when waypoint has no notification info', () => {
      const cp = formatCheckpointV2(sampleWaypoints[2]);
      expect(cp.notification).toBeUndefined();
    });

    it('serializes address, google_place_id, and is_route_anchor when present', () => {
      const richWaypoint: Waypoint = {
        id: 'wp_little_america',
        name: 'Little America Hotel Flagstaff',
        type: 'lodging',
        lat: 35.1901,
        lng: -111.6207,
        dwell_minutes: 0,
        trigger_radius_miles: 2.0,
        address: '2515 E Butler Ave, Flagstaff, AZ 86004',
        google_place_id: 'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q',
        is_route_anchor: true,
      };

      const cp = formatCheckpointV2(richWaypoint);
      expect(cp.address).toBe('2515 E Butler Ave, Flagstaff, AZ 86004');
      expect(cp.google_place_id).toBe('ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q');
      expect(cp.is_route_anchor).toBe(true);
    });

    it('omits notification when alert message and speech are blank or cleared', () => {
      const stopWithClearedAlert: Waypoint = {
        id: 'wp_meal_cleared',
        name: 'Lumberyard Brewing Co',
        type: 'meal',
        lat: 35.195,
        lng: -111.648,
        dwell_minutes: 60,
        trigger_radius_miles: 0.5,
        notification: {
          title: 'Lumberyard Brewing Co',
          message: '',
          speech: '',
        },
      };

      const cp = formatCheckpointV2(stopWithClearedAlert);
      expect(cp.notification).toBeUndefined();
    });
  });

  describe('Multi-Day Itinerary Export (Schema v2.0.0)', () => {
    it('generates compliant v2 multi-day schema with metadata and days', () => {
      const itinerary = formatMultiDayItinerary({
        tripName: 'Phoenix to Albuquerque Road Trip',
        startDate: '2026-10-09',
        endDate: '2026-10-12',
        author: 'Roadtripper',
        description: 'Scenic autumn drive',
        days: [
          {
            dayNumber: 1,
            date: '2026-10-09',
            timezone: 'America/Phoenix',
            title: 'Red Rock Entry & Oak Creek Switchbacks',
            origin: 'Phoenix Sky Harbor',
            destination: 'Flagstaff, AZ',
            departureTime: '14:30:00',
            waypoints: sampleWaypoints,
          },
        ],
      });

      expect(itinerary.trip_name).toBe('Phoenix to Albuquerque Road Trip');
      expect(itinerary.dates).toEqual({
        start: '2026-10-09',
        end: '2026-10-12',
      });
      expect(itinerary.metadata.version).toBe('2.0.0');
      expect(itinerary.metadata.author).toBe('Roadtripper');
      expect(itinerary.metadata.description).toBe('Scenic autumn drive');
      expect(itinerary.metadata.created_at).toBeDefined();

      expect(itinerary.days).toHaveLength(1);
      const day1 = itinerary.days[0];
      expect(day1.day).toBe(1);
      expect(day1.date).toBe('2026-10-09');
      expect(day1.timezone).toBe('America/Phoenix');
      expect(day1.title).toBe('Red Rock Entry & Oak Creek Switchbacks');
      expect(day1.origin).toBe('Phoenix Sky Harbor');
      expect(day1.destination).toBe('Flagstaff, AZ');
      expect(day1.departure_time).toBe('14:30:00');
      expect(day1.checkpoints).toHaveLength(3);

      // Verify JSON serialization
      const jsonStr = exportItineraryToJson(itinerary);
      const parsed = JSON.parse(jsonStr);
      expect(parsed.trip_name).toBe('Phoenix to Albuquerque Road Trip');
      expect(parsed.days[0].checkpoints[1].dwell_minutes).toBe(30);
    });

    it('works seamlessly with ScheduledStop objects from timeline cascade', () => {
      const scheduledStops: ScheduledStop[] = [
        {
          id: 'stop_1',
          name: 'Stop One',
          type: 'origin',
          lat: 34.0,
          lng: -111.0,
          dwell_minutes: 0,
          trigger_radius_miles: 0.5,
          timezone: 'America/Phoenix',
          timezoneAbbreviation: 'MST',
          timezoneOffsetMinutes: -420,
          timezoneOffsetStr: '-07:00',
          arrivalTime: '09:00:00',
          arrivalShortTime: '09:00',
          departureTime: '09:00:00',
          departureShortTime: '09:00',
          localDate: '2026-10-09',
          arrivalIso: '2026-10-09T09:00:00-07:00',
          departureIso: '2026-10-09T09:00:00-07:00',
          arrivalEpochMs: 1791561600000,
          departureEpochMs: 1791561600000,
          driveDurationFromPreviousSeconds: 0,
          driveDistanceMilesFromPrevious: 0,
          isTimezoneBoundaryCrossing: false,
        },
        {
          id: 'stop_2',
          name: 'Stop Two',
          type: 'scenic_pull_off',
          lat: 34.5,
          lng: -111.5,
          dwell_minutes: 20,
          trigger_radius_miles: 2.0,
          timezone: 'America/Phoenix',
          timezoneAbbreviation: 'MST',
          timezoneOffsetMinutes: -420,
          timezoneOffsetStr: '-07:00',
          arrivalTime: '10:15:00',
          arrivalShortTime: '10:15',
          departureTime: '10:35:00',
          departureShortTime: '10:35',
          localDate: '2026-10-09',
          arrivalIso: '2026-10-09T10:15:00-07:00',
          departureIso: '2026-10-09T10:35:00-07:00',
          arrivalEpochMs: 1791566100000,
          departureEpochMs: 1791567300000,
          driveDurationFromPreviousSeconds: 4500,
          driveDistanceMilesFromPrevious: 55,
          isTimezoneBoundaryCrossing: false,
        },
      ];

      const itinerary = formatMultiDayItinerary({
        tripName: 'Cascade Test Trip',
        days: [
          {
            dayNumber: 1,
            date: '2026-10-09',
            scheduledStops,
          },
        ],
      });

      expect(itinerary.days[0].checkpoints[0].target_time).toBe('09:00:00');
      expect(itinerary.days[0].checkpoints[1].target_time).toBe('10:15:00');
      expect(itinerary.days[0].checkpoints[1].dwell_minutes).toBe(20);
    });
  });

  describe('Single Route Itinerary Export', () => {
    it('generates root checkpoints with offset_minutes_from_start', () => {
      const itinerary = formatSingleRouteItinerary({
        tripName: 'Test Run: Albany to Nassau',
        date: '2026-09-06',
        timezone: 'America/New_York',
        waypoints: sampleWaypoints,
      });

      expect(itinerary.trip_name).toBe('Test Run: Albany to Nassau');
      expect(itinerary.checkpoints).toHaveLength(3);
      expect(itinerary.checkpoints[0].offset_minutes_from_start).toBe(0);
      expect(itinerary.checkpoints[1].offset_minutes_from_start).toBe(15);
      expect(itinerary.checkpoints[2].offset_minutes_from_start).toBe(30);
      expect(itinerary.date).toBe('2026-09-06');
      expect(itinerary.timezone).toBe('America/New_York');
    });

    it('calculates offset_minutes_from_start from ScheduledStop epoch differences', () => {
      const scheduledStops: ScheduledStop[] = [
        {
          id: 'start',
          name: 'Start Point',
          type: 'origin',
          lat: 42.653,
          lng: -73.756,
          dwell_minutes: 0,
          trigger_radius_miles: 0.5,
          timezone: 'America/New_York',
          timezoneAbbreviation: 'EDT',
          timezoneOffsetMinutes: -240,
          timezoneOffsetStr: '-04:00',
          arrivalTime: '10:00:00',
          arrivalShortTime: '10:00',
          departureTime: '10:00:00',
          departureShortTime: '10:00',
          localDate: '2026-09-06',
          arrivalIso: '2026-09-06T10:00:00-04:00',
          departureIso: '2026-09-06T10:00:00-04:00',
          arrivalEpochMs: 1700000000000,
          departureEpochMs: 1700000000000,
          driveDurationFromPreviousSeconds: 0,
          driveDistanceMilesFromPrevious: 0,
          isTimezoneBoundaryCrossing: false,
        },
        {
          id: 'end',
          name: 'End Point',
          type: 'destination',
          lat: 42.815,
          lng: -73.941,
          dwell_minutes: 0,
          trigger_radius_miles: 0.5,
          timezone: 'America/New_York',
          timezoneAbbreviation: 'EDT',
          timezoneOffsetMinutes: -240,
          timezoneOffsetStr: '-04:00',
          arrivalTime: '10:31:00',
          arrivalShortTime: '10:31',
          departureTime: '10:31:00',
          departureShortTime: '10:31',
          localDate: '2026-09-06',
          arrivalIso: '2026-09-06T10:31:00-04:00',
          departureIso: '2026-09-06T10:31:00-04:00',
          // 31 minutes later (31 * 60 * 1000 = 1,860,000 ms)
          arrivalEpochMs: 1700000000000 + 1860000,
          departureEpochMs: 1700000000000 + 1860000,
          driveDurationFromPreviousSeconds: 1860,
          driveDistanceMilesFromPrevious: 18.8,
          isTimezoneBoundaryCrossing: false,
        },
      ];

      const singleRoute = formatSingleRouteItinerary({
        tripName: 'Ad-Hoc Drive',
        scheduledStops,
      });

      expect(singleRoute.checkpoints[0].offset_minutes_from_start).toBe(0);
      expect(singleRoute.checkpoints[1].offset_minutes_from_start).toBe(31);
    });

    it('omits date and target_time when isAdHoc is true', () => {
      const singleRoute = formatSingleRouteItinerary({
        tripName: 'Ad-Hoc Shopping Drive',
        waypoints: sampleWaypoints,
        isAdHoc: true,
      });

      expect(singleRoute.date).toBeUndefined();
      expect(singleRoute.checkpoints[0].target_time).toBeUndefined();
      expect(singleRoute.checkpoints[0].offset_minutes_from_start).toBe(0);
      expect(singleRoute.checkpoints[1].target_time).toBeUndefined();
      expect(singleRoute.checkpoints[1].offset_minutes_from_start).toBe(15);
    });
  });

  describe('downloadItineraryJson', () => {
    let originalDocument: unknown;
    let originalCreateObjectURL: typeof URL.createObjectURL;
    let originalRevokeObjectURL: typeof URL.revokeObjectURL;

    beforeEach(() => {
      originalDocument = (globalThis as unknown as { document?: unknown }).document;
      originalCreateObjectURL = URL.createObjectURL;
      originalRevokeObjectURL = URL.revokeObjectURL;
    });

    afterEach(() => {
      (globalThis as unknown as { document?: unknown }).document = originalDocument;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
      vi.restoreAllMocks();
    });

    it('creates a download link, sets filename, and triggers click', () => {
      const fakeUrl = 'blob:http://localhost/test-blob-uuid';
      const mockCreateObjectURL = vi.fn().mockReturnValue(fakeUrl);
      const mockRevokeObjectURL = vi.fn();
      URL.createObjectURL = mockCreateObjectURL;
      URL.revokeObjectURL = mockRevokeObjectURL;

      const clickMock = vi.fn();
      const appendChildMock = vi.fn();
      const removeChildMock = vi.fn();

      const mockAnchor = {
        href: '',
        download: '',
        click: clickMock,
      };

      (globalThis as unknown as { document: unknown }).document = {
        createElement: vi.fn().mockReturnValue(mockAnchor),
        body: {
          appendChild: appendChildMock,
          removeChild: removeChildMock,
        },
      };

      downloadItineraryJson({ test: true } as unknown as Waypoint, 'my_custom_trip');

      expect(mockAnchor.download).toBe('my_custom_trip.json');
      expect(mockAnchor.href).toBe(fakeUrl);
      expect(clickMock).toHaveBeenCalledTimes(1);
      expect(appendChildMock).toHaveBeenCalledWith(mockAnchor);
      expect(removeChildMock).toHaveBeenCalledWith(mockAnchor);
      expect(mockRevokeObjectURL).toHaveBeenCalledWith(fakeUrl);
    });
  });
});
