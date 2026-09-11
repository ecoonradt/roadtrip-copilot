import { describe, it, expect } from 'vitest';
import {
  calculateTimelineCascade,
  calculateBackwardSchedule,
  applyDwellDelta,
  detectTimezone,
  parseLocalToUtcEpoch,
  getTimezoneDetails,
  haversineMiles,
  estimateDriveDurationSeconds,
  AZ_NM_LONGITUDE_BOUNDARY,
} from '../../src/engine/cascade';
import type { TimelineCascadeWaypoint, TimelineCascadeInput } from '../../src/engine/types';

describe('Timeline Cascade Engine (cascade.ts)', () => {
  // Test route modeled after Day 1 & Day 2 of PHX -> ABQ trip
  const SAMPLE_WAYPOINTS: TimelineCascadeWaypoint[] = [
    {
      id: 'wp_phx',
      name: 'PHX Rental Car Facility',
      type: 'origin',
      lat: 33.4357,
      lng: -112.0152,
      dwell_minutes: 0,
    },
    {
      id: 'wp_sedona',
      name: 'Sedona Bell Rock',
      type: 'scenic_pull_off',
      lat: 34.801,
      lng: -111.7645,
      dwell_minutes: 30,
    },
    {
      id: 'wp_oak_creek',
      name: 'Oak Creek Canyon Vista',
      type: 'scenic_pull_off',
      lat: 35.0345,
      lng: -111.733,
      dwell_minutes: 20,
    },
    {
      id: 'wp_flagstaff',
      name: 'Little America Hotel Flagstaff',
      type: 'lodging',
      lat: 35.1878,
      lng: -111.6152,
      dwell_minutes: 0,
    },
  ];

  // Drive durations:
  // PHX -> Sedona: 6300s (1h 45m)
  // Sedona -> Oak Creek: 1800s (30m)
  // Oak Creek -> Flagstaff: 1500s (25m)
  const SAMPLE_DURATIONS = [6300, 1800, 1500];
  const SAMPLE_DISTANCES = [115, 17, 14];

  describe('Invariant 1: Deterministic Cascade Ripple & Dwell Time Updates', () => {
    it('calculates initial forward cascade schedule correctly', () => {
      const input: TimelineCascadeInput = {
        baseDate: '2026-10-09',
        departureTime: '14:30:00',
        defaultTimezone: 'America/Phoenix',
        waypoints: SAMPLE_WAYPOINTS,
        driveDurationsSeconds: SAMPLE_DURATIONS,
        driveDistancesMiles: SAMPLE_DISTANCES,
      };

      const result = calculateTimelineCascade(input);

      expect(result.stops).toHaveLength(4);

      // Stop 0: Depart PHX @ 14:30:00, Dwell: 0m -> Depart @ 14:30:00
      expect(result.stops[0].arrivalTime).toBe('14:30:00');
      expect(result.stops[0].departureTime).toBe('14:30:00');
      expect(result.stops[0].dwell_minutes).toBe(0);

      // Stop 1: Arrive Sedona @ 14:30 + 1h45m = 16:15:00, Dwell 30m -> Depart @ 16:45:00
      expect(result.stops[1].arrivalTime).toBe('16:15:00');
      expect(result.stops[1].departureTime).toBe('16:45:00');
      expect(result.stops[1].dwell_minutes).toBe(30);

      // Stop 2: Arrive Oak Creek @ 16:45 + 30m = 17:15:00, Dwell 20m -> Depart @ 17:35:00
      expect(result.stops[2].arrivalTime).toBe('17:15:00');
      expect(result.stops[2].departureTime).toBe('17:35:00');
      expect(result.stops[2].dwell_minutes).toBe(20);

      // Stop 3: Arrive Flagstaff @ 17:35 + 25m = 18:00:00, Dwell 0m -> Depart @ 18:00:00
      expect(result.stops[3].arrivalTime).toBe('18:00:00');
      expect(result.stops[3].departureTime).toBe('18:00:00');

      // Totals
      expect(result.totalDriveSeconds).toBe(6300 + 1800 + 1500); // 9600s = 160m = 2h 40m
      expect(result.totalDwellMinutes).toBe(50);
      expect(result.totalTripSeconds).toBe(9600 + 50 * 60); // 12600s = 3h 30m
    });

    it('Scenario 1: Modifying dwell time on stop 2 (Sedona) accurately shifts arrival on stops 3 through N by exact delta', () => {
      const baseInput: TimelineCascadeInput = {
        baseDate: '2026-10-09',
        departureTime: '14:30:00',
        defaultTimezone: 'America/Phoenix',
        waypoints: SAMPLE_WAYPOINTS,
        driveDurationsSeconds: SAMPLE_DURATIONS,
        driveDistancesMiles: SAMPLE_DISTANCES,
      };

      const initialResult = calculateTimelineCascade(baseInput);

      // Increase Sedona (index 1) dwell time from 30m to 60m (+30 minutes)
      const deltaMinutes = 30;
      const rippleResult = applyDwellDelta(baseInput, 1, 60);

      expect(rippleResult.stops).toHaveLength(4);

      // Stop 0: PHX arrival & departure remain completely UNCHANGED
      expect(rippleResult.stops[0].arrivalTime).toBe(initialResult.stops[0].arrivalTime);
      expect(rippleResult.stops[0].departureTime).toBe(initialResult.stops[0].departureTime);
      expect(rippleResult.stops[0].arrivalEpochMs).toBe(initialResult.stops[0].arrivalEpochMs);

      // Stop 1 (Sedona): Arrival remains UNCHANGED (16:15:00)
      expect(rippleResult.stops[1].arrivalTime).toBe(initialResult.stops[1].arrivalTime);
      expect(rippleResult.stops[1].arrivalEpochMs).toBe(initialResult.stops[1].arrivalEpochMs);

      // Stop 1 (Sedona): Departure is shifted by +30m (from 16:45:00 to 17:15:00)
      expect(rippleResult.stops[1].departureTime).toBe('17:15:00');
      expect(rippleResult.stops[1].departureEpochMs - initialResult.stops[1].departureEpochMs)
        .toBe(deltaMinutes * 60 * 1000);

      // Stop 2 (Oak Creek): Arrival and departure are shifted by exactly +30m
      expect(rippleResult.stops[2].arrivalTime).toBe('17:45:00'); // was 17:15:00
      expect(rippleResult.stops[2].departureTime).toBe('18:05:00'); // was 17:35:00
      expect(rippleResult.stops[2].arrivalEpochMs - initialResult.stops[2].arrivalEpochMs)
        .toBe(deltaMinutes * 60 * 1000);
      expect(rippleResult.stops[2].departureEpochMs - initialResult.stops[2].departureEpochMs)
        .toBe(deltaMinutes * 60 * 1000);

      // Stop 3 (Flagstaff): Arrival and departure shifted by exactly +30m
      expect(rippleResult.stops[3].arrivalTime).toBe('18:30:00'); // was 18:00:00
      expect(rippleResult.stops[3].departureTime).toBe('18:30:00');
      expect(rippleResult.stops[3].arrivalEpochMs - initialResult.stops[3].arrivalEpochMs)
        .toBe(deltaMinutes * 60 * 1000);

      // Dwell totals reflected
      expect(rippleResult.totalDwellMinutes).toBe(initialResult.totalDwellMinutes + deltaMinutes);
    });

    it('handles decreasing dwell time (e.g. from 30m down to 10m) shifting subsequent stops earlier', () => {
      const baseInput: TimelineCascadeInput = {
        baseDate: '2026-10-09',
        departureTime: '14:30:00',
        defaultTimezone: 'America/Phoenix',
        waypoints: SAMPLE_WAYPOINTS,
        driveDurationsSeconds: SAMPLE_DURATIONS,
        driveDistancesMiles: SAMPLE_DISTANCES,
      };

      const rippleResult = applyDwellDelta(baseInput, 1, 10); // -20m delta

      // Sedona departure shifts from 16:45 to 16:25
      expect(rippleResult.stops[1].departureTime).toBe('16:25:00');
      // Oak Creek arrival shifts from 17:15 to 16:55
      expect(rippleResult.stops[2].arrivalTime).toBe('16:55:00');
      // Flagstaff arrival shifts from 18:00 to 17:40
      expect(rippleResult.stops[3].arrivalTime).toBe('17:40:00');
    });
  });

  describe('Invariant 2: Timezone Detection & State Border Shifts (AZ -> NM)', () => {
    it('detects correct timezones across Arizona and New Mexico coordinates', () => {
      // Phoenix, AZ
      expect(detectTimezone(33.4357, -112.0152)).toBe('America/Phoenix');
      // Flagstaff, AZ
      expect(detectTimezone(35.1878, -111.6152)).toBe('America/Phoenix');
      // Painted Desert, AZ (-110.0545 is west of -109.0452)
      expect(detectTimezone(34.981, -110.0545)).toBe('America/Phoenix');

      // Gallup, NM (-108.7426 is east of -109.0452)
      expect(detectTimezone(35.5281, -108.7426)).toBe('America/Denver');
      // Shiprock, NM
      expect(detectTimezone(36.6872, -108.6875)).toBe('America/Denver');
      // Chama, NM
      expect(detectTimezone(36.8833, -106.5828)).toBe('America/Denver');
      // Albuquerque, NM
      expect(detectTimezone(35.0433, -106.6094)).toBe('America/Denver');
    });

    it('Scenario 2: Crossing from AZ (MST, UTC-7) into NM (MDT, UTC-6) applies the +1 hour jump correctly in local time while epoch is linear', () => {
      // Day 2 scenario: Depart Flagstaff AZ at 07:30:00 MST, drive 2 hours (7200s) to Gallup NM
      const day2Waypoints: TimelineCascadeWaypoint[] = [
        {
          id: 'wp_flagstaff_depart',
          name: 'Depart Flagstaff Hotel',
          lat: 35.1878,
          lng: -111.6152, // AZ (America/Phoenix, UTC-7)
          dwell_minutes: 0,
        },
        {
          id: 'wp_gallup_fuel',
          name: 'Gallup Fuel Stop',
          lat: 35.5281,
          lng: -108.7426, // NM (America/Denver, UTC-6 in DST)
          dwell_minutes: 30,
        },
      ];

      const input: TimelineCascadeInput = {
        baseDate: '2026-10-10',
        departureTime: '07:30:00',
        defaultTimezone: 'America/Phoenix',
        waypoints: day2Waypoints,
        driveDurationsSeconds: [7200], // exactly 2 hours (120 minutes)
        driveDistancesMiles: [185],
      };

      const result = calculateTimelineCascade(input);

      expect(result.stops).toHaveLength(2);

      const flagstaff = result.stops[0];
      const gallup = result.stops[1];

      // Flagstaff timezone and departure
      expect(flagstaff.timezone).toBe('America/Phoenix');
      expect(flagstaff.timezoneAbbreviation).toBe('MST');
      expect(flagstaff.timezoneOffsetMinutes).toBe(-420); // UTC-7
      expect(flagstaff.departureTime).toBe('07:30:00');
      expect(flagstaff.isTimezoneBoundaryCrossing).toBe(false);

      // Gallup timezone and arrival
      expect(gallup.timezone).toBe('America/Denver');
      expect(gallup.timezoneAbbreviation).toBe('MDT');
      expect(gallup.timezoneOffsetMinutes).toBe(-360); // UTC-6
      expect(gallup.isTimezoneBoundaryCrossing).toBe(true);
      expect(gallup.timezoneShiftHours).toBe(1); // +1 hour time shift

      // Mathematical Verification:
      // Elapsed physical drive time = exactly 2 hours (7,200,000 ms)
      const elapsedMs = gallup.arrivalEpochMs - flagstaff.departureEpochMs;
      expect(elapsedMs).toBe(7200 * 1000);

      // Local clock in Arizona would be 07:30 + 2h = 09:30 MST.
      // But in New Mexico (UTC-6), the local clock jumps +1 hour to 10:30 MDT!
      expect(gallup.arrivalTime).toBe('10:30:00');
      expect(gallup.departureTime).toBe('11:00:00'); // 10:30 + 30m dwell

      // Timezones crossed
      expect(result.timezonesCrossed).toEqual(['America/Phoenix', 'America/Denver']);
    });

    it('honors explicit waypoint timezone property override if provided', () => {
      const waypointsWithOverride: TimelineCascadeWaypoint[] = [
        {
          id: 'wp1',
          name: 'Point A',
          lat: 35.1878,
          lng: -111.6152, // Would detect America/Phoenix
          timezone: 'America/New_York', // Explicit override
          dwell_minutes: 0,
        },
      ];

      const result = calculateTimelineCascade({
        baseDate: '2026-10-09',
        departureTime: '12:00:00',
        waypoints: waypointsWithOverride,
      });

      expect(result.stops[0].timezone).toBe('America/New_York');
      expect(result.stops[0].timezoneAbbreviation).toBe('EDT');
      expect(result.stops[0].timezoneOffsetMinutes).toBe(-240); // UTC-4
    });
  });

  describe('Invariant 4: Backwards Scheduling Mode ("The Flight Catch-up")', () => {
    it('Scenario 4: Determines required departure time given destination target arrival deadline', () => {
      // Day 4 scenario:
      // Destination: ABQ Sunport Airport, must arrive by 16:30:00
      // Stops:
      // 1. Taos Plaza (dwell 30m)
      // 2. Chimayo (dwell 20m)
      // 3. Santa Fe (dwell 15m)
      // 4. ABQ Sunport (destination, target 16:30:00)
      const day4Waypoints: TimelineCascadeWaypoint[] = [
        {
          id: 'wp_taos',
          name: 'Taos Plaza',
          lat: 36.4072,
          lng: -105.5734,
          dwell_minutes: 30,
        },
        {
          id: 'wp_chimayo',
          name: 'El Santuario de Chimayo',
          lat: 35.9862,
          lng: -105.9304,
          dwell_minutes: 20,
        },
        {
          id: 'wp_santa_fe',
          name: 'Santa Fe Plaza',
          lat: 35.687,
          lng: -105.9378,
          dwell_minutes: 15,
        },
        {
          id: 'wp_abq_sunport',
          name: 'ABQ Sunport Airport Drop-off',
          lat: 35.0433,
          lng: -106.6094,
          dwell_minutes: 0,
        },
      ];

      // Pairwise drive durations:
      // Taos -> Chimayo: 3600s (1h 00m)
      // Chimayo -> Santa Fe: 2400s (40m)
      // Santa Fe -> ABQ: 3600s (1h 00m)
      const durations = [3600, 2400, 3600]; // Total drive: 9600s (2h 40m)
      // Dwells at earlier stops:
      // Taos: 30m, Chimayo: 20m, Santa Fe: 15m -> Total intermediate dwell: 65m
      // Total elapsed from Taos arrival to ABQ arrival:
      // 30m (Taos dwell) + 60m (drive) + 20m (Chimayo dwell) + 40m (drive) + 15m (Santa Fe dwell) + 60m (drive)
      // = 225 minutes = 3 hours 45 minutes!
      // If ABQ arrival is 16:30:00, departure from Taos Plaza must be:
      // 16:30 - 3h 45m = 12:45:00!

      const backwardInput = {
        baseDate: '2026-10-12',
        targetArrivalTime: '16:30:00',
        destinationTimezone: 'America/Denver',
        waypoints: day4Waypoints,
        driveDurationsSeconds: durations,
      };

      const backwardResult = calculateBackwardSchedule(backwardInput);

      expect(backwardResult.requiredDepartureTime).toBe('12:45:00');
      expect(backwardResult.originTimezone).toBe('America/Denver');
      expect(backwardResult.targetArrivalTime).toBe('16:30:00');

      // Verify forward cascade using this required departure time lands on 16:30:00 at ABQ
      const forwardResult = backwardResult.cascadeResult;
      const lastStop = forwardResult.stops[forwardResult.stops.length - 1];

      expect(lastStop.name).toBe('ABQ Sunport Airport Drop-off');
      expect(lastStop.arrivalTime).toBe('16:30:00');
      expect(forwardResult.stops[0].arrivalTime).toBe('12:45:00');
      expect(forwardResult.stops[0].departureTime).toBe('13:15:00'); // 12:45 + 30m dwell
    });

    it('works backwards across timezone boundaries (e.g. AZ origin to NM destination)', () => {
      // Origin in AZ (America/Phoenix, MST, UTC-7)
      // Destination in NM (America/Denver, MDT, UTC-6)
      // Target arrival at NM: 14:00:00 MDT
      // Drive duration: 7200s (2 hours)
      // Origin dwell: 0
      const crossBorderWaypoints: TimelineCascadeWaypoint[] = [
        {
          id: 'az_start',
          name: 'Flagstaff, AZ',
          lat: 35.1878,
          lng: -111.6152, // AZ
          dwell_minutes: 0,
        },
        {
          id: 'nm_end',
          name: 'Gallup, NM',
          lat: 35.5281,
          lng: -108.7426, // NM
          dwell_minutes: 0,
        },
      ];

      const backwardResult = calculateBackwardSchedule({
        baseDate: '2026-10-10',
        targetArrivalTime: '14:00:00',
        waypoints: crossBorderWaypoints,
        driveDurationsSeconds: [7200],
      });

      // Target arrival at Gallup: 14:00:00 MDT (UTC-6 = 20:00:00 UTC)
      // Drive is 2 hours: departure must occur at 18:00:00 UTC
      // In Arizona (UTC-7), 18:00:00 UTC corresponds to 11:00:00 MST!
      // (11:00 MST + 2h drive + 1h timezone jump = 14:00 MDT)
      expect(backwardResult.requiredDepartureTime).toBe('11:00:00');
      expect(backwardResult.originTimezone).toBe('America/Phoenix');

      // Forward validation
      const finalStop = backwardResult.cascadeResult.stops[1];
      expect(finalStop.arrivalTime).toBe('14:00:00');
    });
  });

  describe('Adversarial & Edge Cases', () => {
    it('handles empty waypoints array gracefully', () => {
      const result = calculateTimelineCascade({
        baseDate: '2026-10-09',
        departureTime: '14:30:00',
        waypoints: [],
      });

      expect(result.stops).toHaveLength(0);
      expect(result.totalTripSeconds).toBe(0);
      expect(result.timezonesCrossed).toHaveLength(0);
    });

    it('handles single-stop route cleanly', () => {
      const singleWp: TimelineCascadeWaypoint[] = [
        {
          id: 'single',
          name: 'Lone Stop',
          lat: 33.4357,
          lng: -112.0152,
          dwell_minutes: 45,
        },
      ];

      const result = calculateTimelineCascade({
        baseDate: '2026-10-09',
        departureTime: '10:00:00',
        waypoints: singleWp,
      });

      expect(result.stops).toHaveLength(1);
      expect(result.stops[0].arrivalTime).toBe('10:00:00');
      expect(result.stops[0].departureTime).toBe('10:45:00');
      expect(result.totalDriveSeconds).toBe(0);
      expect(result.totalDwellMinutes).toBe(45);
    });

    it('falls back to haversine estimation when drive durations are missing', () => {
      const waypointsNoDurations: TimelineCascadeWaypoint[] = [
        {
          id: 'w1',
          name: 'Point A',
          lat: 33.4357,
          lng: -112.0152,
          dwell_minutes: 0,
        },
        {
          id: 'w2',
          name: 'Point B',
          lat: 34.801,
          lng: -111.7645,
          dwell_minutes: 0,
        },
      ];

      const result = calculateTimelineCascade({
        baseDate: '2026-10-09',
        departureTime: '08:00:00',
        waypoints: waypointsNoDurations,
      });

      expect(result.stops).toHaveLength(2);
      expect(result.stops[1].driveDurationFromPreviousSeconds).toBeGreaterThan(0);
      expect(result.stops[1].driveDistanceMilesFromPrevious).toBeGreaterThan(0);
      expect(result.stops[1].arrivalTime).not.toBe('08:00:00');
    });

    it('clamps negative dwell minutes to 0', () => {
      const negativeDwellWp: TimelineCascadeWaypoint[] = [
        {
          id: 'w1',
          name: 'Point A',
          lat: 33.4357,
          lng: -112.0152,
          dwell_minutes: -15,
        },
      ];

      const result = calculateTimelineCascade({
        baseDate: '2026-10-09',
        departureTime: '09:00:00',
        waypoints: negativeDwellWp,
      });

      expect(result.stops[0].dwell_minutes).toBe(0);
      expect(result.stops[0].departureTime).toBe('09:00:00');
    });

    it('throws descriptive error on malformed baseDate or departureTime', () => {
      expect(() => {
        parseLocalToUtcEpoch('not-a-date', '14:30:00', 'America/Phoenix');
      }).toThrow(/Invalid baseDate/);

      expect(() => {
        parseLocalToUtcEpoch('2026-10-09', '99:99:99', 'America/Phoenix');
      }).toThrow(/Time components out of bounds/);

      expect(() => {
        parseLocalToUtcEpoch('2026-10-09', 'invalid', 'America/Phoenix');
      }).toThrow(/Invalid timeStr/);
    });

    it('accurately calculates haversine distance and duration', () => {
      // Known distance between PHX (33.4357, -112.0152) and Sedona (34.8010, -111.7645) is ~95-100 straight-line miles
      const distance = haversineMiles(33.4357, -112.0152, 34.801, -111.7645);
      expect(distance).toBeGreaterThan(90);
      expect(distance).toBeLessThan(110);

      // Duration for 100 miles at 50 mph should be 2 hours (7200 seconds)
      const duration = estimateDriveDurationSeconds(100, 50);
      expect(duration).toBe(7200);
    });
  });
});
