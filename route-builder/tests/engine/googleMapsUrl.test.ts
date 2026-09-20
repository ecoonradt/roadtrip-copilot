import { describe, it, expect } from 'vitest';
import {
  generateGoogleMapsUrls,
  buildSingleGoogleMapsUrl,
  formatCoord,
  MAX_INTERMEDIATE_WAYPOINTS,
  GOOGLE_MAPS_DIR_BASE,
} from '../../src/engine/googleMapsUrl';
import type { CoordinateLocation } from '../../src/engine/types';

describe('Google Maps Navigation Link Generator (googleMapsUrl.ts)', () => {
  // Helper to generate N test waypoints along a simulated route
  function createTestWaypoints(count: number): CoordinateLocation[] {
    const points: CoordinateLocation[] = [];
    for (let i = 0; i < count; i++) {
      points.push({
        lat: Number((33.0 + i * 0.2).toFixed(4)),
        lng: Number((-112.0 + i * 0.15).toFixed(4)),
        name: `Waypoint ${i + 1}`,
      });
    }
    return points;
  }

  describe('Single Link & URL Formatting', () => {
    it('constructs standard URL for 2-waypoint route with no intermediate stops', () => {
      const origin: CoordinateLocation = { lat: 33.4357, lng: -112.0152, name: 'PHX Airport' };
      const dest: CoordinateLocation = { lat: 35.1878, lng: -111.6152, name: 'Flagstaff' };

      const url = buildSingleGoogleMapsUrl(origin, dest, []);

      expect(url).toBe(
        'https://www.google.com/maps/dir/?api=1&origin=33.4357,-112.0152&destination=35.1878,-111.6152&travelmode=driving'
      );
      // No &waypoints= when there are no intermediate waypoints
      expect(url).not.toContain('&waypoints=');
    });

    it('constructs multi-stop URL with pipe-separated intermediate coordinates matching architecture doc', () => {
      const origin: CoordinateLocation = { lat: 33.4357, lng: -112.0152 };
      const dest: CoordinateLocation = { lat: 35.1878, lng: -111.6152 };
      const intermediate: CoordinateLocation[] = [
        { lat: 34.801, lng: -111.7645 },
        { lat: 35.0345, lng: -111.733 },
      ];

      const url = buildSingleGoogleMapsUrl(origin, dest, intermediate);

      expect(url).toBe(
        'https://www.google.com/maps/dir/?api=1&origin=33.4357,-112.0152&destination=35.1878,-111.6152&waypoints=34.801,-111.7645|35.0345,-111.733&travelmode=driving'
      );
    });

    it('formats coordinates cleanly without extra precision artifacts', () => {
      expect(formatCoord(33.435700001, -112.015200002)).toBe('33.4357,-112.0152');
      expect(formatCoord(35, -111)).toBe('35,-111');
    });
  });

  describe('Invariant 3: Leg Partitioning & Chunking Limits (<= 9 Intermediate Waypoints)', () => {
    it('Scenario 3A: 11-waypoint route generates exactly 1 leg with 9 intermediate stops', () => {
      // 11 points total: 1 origin, 9 intermediate, 1 destination
      const waypoints = createTestWaypoints(11);

      const result = generateGoogleMapsUrls(waypoints);

      expect(result.totalLegs).toBe(1);
      expect(result.legs).toHaveLength(1);

      const leg = result.legs[0];
      expect(leg.title).toBe('Full Route');
      expect(leg.waypointCount).toBe(11);
      expect(leg.origin).toEqual(waypoints[0]);
      expect(leg.destination).toEqual(waypoints[10]);
      expect(leg.intermediateWaypoints).toHaveLength(9);
      expect(leg.intermediateWaypoints).toEqual(waypoints.slice(1, 10));

      // Verify the URL structure
      expect(leg.url).toContain('origin=33,-112');
      expect(leg.url).toContain('destination=35,-110.5');
      // Pipe count in waypoints parameter should be 8 (for 9 intermediate waypoints)
      const waypointsParam = leg.url.split('&waypoints=')[1].split('&')[0];
      const pipes = (waypointsParam.match(/\|/g) || []).length;
      expect(pipes).toBe(8);

      expect(result.primaryUrl).toBe(leg.url);
    });

    it('Scenario 3B: 12-waypoint route cleanly splits into 2 valid Google Maps URLs with continuity', () => {
      // 12 points total: exceeds 11-point limit by 1
      const waypoints = createTestWaypoints(12);

      const result = generateGoogleMapsUrls(waypoints);

      expect(result.totalLegs).toBe(2);
      expect(result.legs).toHaveLength(2);

      const [leg1, leg2] = result.legs;

      // Leg 1: origin W0, destination W10, 9 intermediate waypoints (W1..W9)
      expect(leg1.title).toBe('Leg 1 (Morning)');
      expect(leg1.waypointCount).toBe(11);
      expect(leg1.origin).toEqual(waypoints[0]);
      expect(leg1.destination).toEqual(waypoints[10]);
      expect(leg1.intermediateWaypoints).toHaveLength(9);
      expect(leg1.intermediateWaypoints.length).toBeLessThanOrEqual(MAX_INTERMEDIATE_WAYPOINTS);

      // Leg 2: starts at W10 (continuity), destination W11, 0 intermediate waypoints
      expect(leg2.title).toBe('Leg 2 (Afternoon)');
      expect(leg2.waypointCount).toBe(2);
      expect(leg2.origin).toEqual(waypoints[10]); // CONTINUITY: Leg 1 dest is Leg 2 origin
      expect(leg2.destination).toEqual(waypoints[11]);
      expect(leg2.intermediateWaypoints).toHaveLength(0);

      // Verify Leg 2 has no waypoints parameter because 0 intermediate
      expect(leg2.url).not.toContain('&waypoints=');
      expect(leg2.url).toContain(
        `origin=${formatCoord(waypoints[10].lat, waypoints[10].lng)}`
      );
      expect(leg2.url).toContain(
        `destination=${formatCoord(waypoints[11].lat, waypoints[11].lng)}`
      );

      // Primary URL points to Leg 1
      expect(result.primaryUrl).toBe(leg1.url);
    });

    it('Scenario 3C: 15-waypoint route splits into 2 valid legs (9 intermediate on Leg 1, 3 on Leg 2)', () => {
      const waypoints = createTestWaypoints(15);

      const result = generateGoogleMapsUrls(waypoints);

      expect(result.totalLegs).toBe(2);
      const [leg1, leg2] = result.legs;

      // Leg 1: W0 to W10 (11 points, 9 intermediate)
      expect(leg1.waypointCount).toBe(11);
      expect(leg1.origin).toEqual(waypoints[0]);
      expect(leg1.destination).toEqual(waypoints[10]);
      expect(leg1.intermediateWaypoints).toHaveLength(9);

      // Leg 2: W10 to W14 (5 points, 3 intermediate)
      expect(leg2.waypointCount).toBe(5);
      expect(leg2.origin).toEqual(waypoints[10]);
      expect(leg2.destination).toEqual(waypoints[14]);
      expect(leg2.intermediateWaypoints).toHaveLength(3);
      expect(leg2.intermediateWaypoints).toEqual(waypoints.slice(11, 14));
    });

    it('Scenario 3D: 22-waypoint route splits into 3 valid legs with strict continuity', () => {
      const waypoints = createTestWaypoints(22);

      const result = generateGoogleMapsUrls(waypoints);

      expect(result.totalLegs).toBe(3);
      const [leg1, leg2, leg3] = result.legs;

      expect(leg1.title).toBe('Leg 1 (Morning)');
      expect(leg1.origin).toEqual(waypoints[0]);
      expect(leg1.destination).toEqual(waypoints[10]);
      expect(leg1.intermediateWaypoints).toHaveLength(9);

      expect(leg2.title).toBe('Leg 2 (Midday)');
      expect(leg2.origin).toEqual(waypoints[10]); // Continuous with Leg 1
      expect(leg2.destination).toEqual(waypoints[20]);
      expect(leg2.intermediateWaypoints).toHaveLength(9);

      expect(leg3.title).toBe('Leg 3 (Afternoon)');
      expect(leg3.origin).toEqual(waypoints[20]); // Continuous with Leg 2
      expect(leg3.destination).toEqual(waypoints[21]);
      expect(leg3.intermediateWaypoints).toHaveLength(0);

      // Every leg must strictly comply with the <= 9 intermediate limit
      result.legs.forEach((leg) => {
        expect(leg.intermediateWaypoints.length).toBeLessThanOrEqual(MAX_INTERMEDIATE_WAYPOINTS);
        expect(leg.url.startsWith(GOOGLE_MAPS_DIR_BASE)).toBe(true);
      });
    });

    it('supports custom leg titles', () => {
      const waypoints = createTestWaypoints(12);
      const result = generateGoogleMapsUrls(waypoints, {
        customLegTitles: ['Flagstaff to Gallup', 'Gallup to Chama'],
      });

      expect(result.legs[0].title).toBe('Flagstaff to Gallup');
      expect(result.legs[1].title).toBe('Gallup to Chama');
    });
  });

  describe('Edge Cases', () => {
    it('handles empty waypoints array', () => {
      const result = generateGoogleMapsUrls([]);
      expect(result.totalLegs).toBe(0);
      expect(result.legs).toHaveLength(0);
      expect(result.primaryUrl).toBe('');
    });

    it('handles single-point route', () => {
      const singlePoint: CoordinateLocation = { lat: 34.0, lng: -111.0, name: 'Solo' };
      const result = generateGoogleMapsUrls([singlePoint]);

      expect(result.totalLegs).toBe(1);
      expect(result.legs[0].origin).toEqual(singlePoint);
      expect(result.legs[0].destination).toEqual(singlePoint);
      expect(result.legs[0].intermediateWaypoints).toHaveLength(0);
      expect(result.legs[0].url).toContain('origin=34,-111&destination=34,-111');
    });

    it('handles 2-waypoint route as single leg', () => {
      const points = createTestWaypoints(2);
      const result = generateGoogleMapsUrls(points);

      expect(result.totalLegs).toBe(1);
      expect(result.legs[0].title).toBe('Full Route');
      expect(result.legs[0].intermediateWaypoints).toHaveLength(0);
    });
  });

  describe('Smart Schema & Place ID Binding with Navigation Filtering', () => {
    it('binds origin_place_id and destination_place_id when placeId is provided', () => {
      const origin: CoordinateLocation = {
        lat: 33.4308,
        lng: -112.0444,
        name: 'PHX Rental Car Center',
        address: '1805 E Sky Harbor Cir S, Phoenix, AZ',
        placeId: 'ChIJ-Tj-S_AKK4cR2G-y91c-b-I',
      };
      const dest: CoordinateLocation = {
        lat: 35.1901,
        lng: -111.6207,
        name: 'Little America Hotel Flagstaff',
        address: '2515 E Butler Ave, Flagstaff, AZ 86004',
        placeId: 'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q',
      };

      const url = buildSingleGoogleMapsUrl(origin, dest, []);

      expect(url).toContain('origin_place_id=ChIJ-Tj-S_AKK4cR2G-y91c-b-I');
      expect(url).toContain('destination_place_id=ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q');
      expect(url).toContain(encodeURIComponent('1805 E Sky Harbor Cir S, Phoenix, AZ'));
      expect(url).toContain(encodeURIComponent('2515 E Butler Ave, Flagstaff, AZ 86004'));
      expect(url).not.toContain('35.1901,-111.6207'); // Address preferred over bare coordinate
    });

    it('binds waypoint_place_ids when all intermediate waypoints have placeId', () => {
      const origin: CoordinateLocation = { lat: 33.43, lng: -112.04, name: 'Start' };
      const dest: CoordinateLocation = { lat: 35.19, lng: -111.62, name: 'End' };
      const intermediate: CoordinateLocation[] = [
        { lat: 34.79, lng: -111.76, name: 'Bell Rock Vista', placeId: 'ChIJ_bell_rock' },
        { lat: 35.03, lng: -111.73, name: 'Oak Creek Vista', placeId: 'ChIJ_oak_creek' },
      ];

      const url = buildSingleGoogleMapsUrl(origin, dest, intermediate);

      expect(url).toContain('&waypoint_place_ids=ChIJ_bell_rock|ChIJ_oak_creek');
    });

    it('binds waypoint_place_ids positionally with empty slots when only a subset of intermediate waypoints have placeId', () => {
      const origin: CoordinateLocation = { lat: 33.43, lng: -112.04, name: 'Start' };
      const dest: CoordinateLocation = { lat: 35.19, lng: -111.62, name: 'End' };
      const intermediate: CoordinateLocation[] = [
        { lat: 35.07, lng: -109.78, name: 'Tiponi Point' }, // No Place ID
        { lat: 36.73, lng: -108.24, name: 'Maverik', placeId: 'ChIJCR3fWhuQO4cRxCLXXbAfCxQ' }, // Has Place ID
        { lat: 36.74, lng: -107.57, name: 'US-64 Scenic' }, // No Place ID
      ];

      const url = buildSingleGoogleMapsUrl(origin, dest, intermediate);

      // Positional mapping: first is empty, second is Maverik ID, third is empty
      expect(url).toContain('&waypoint_place_ids=|ChIJCR3fWhuQO4cRxCLXXbAfCxQ|');
    });

    it('strips parenthetical qualifiers like (West Main St) from clean place names', () => {
      const origin: CoordinateLocation = { lat: 35.19, lng: -111.62, name: 'Start' };
      const dest: CoordinateLocation = { lat: 36.87, lng: -106.58, name: 'End' };
      const intermediate: CoordinateLocation[] = [
        {
          lat: 36.7328,
          lng: -108.2444,
          name: 'Maverik (West Main St)',
          address: '2701 W Main St, Farmington, NM 87401',
          type: 'fuel',
          dwellMinutes: 15,
        },
      ];

      const url = buildSingleGoogleMapsUrl(origin, dest, intermediate);

      // Should format as "Maverik, 2701 W Main St..." rather than "Maverik (West Main St), 2701 W Main St..."
      expect(url).toContain(encodeURIComponent('Maverik, 2701 W Main St, Farmington, NM 87401'));
      expect(url).not.toContain(encodeURIComponent('Maverik (West Main St)'));
    });

    it('prioritizes explicit placeName over waypoint name in navigation query', () => {
      const origin: CoordinateLocation = { lat: 35.19, lng: -111.62, name: 'Start' };
      const dest: CoordinateLocation = { lat: 36.87, lng: -106.58, name: 'End' };
      const intermediate: CoordinateLocation[] = [
        {
          lat: 36.7328,
          lng: -108.2444,
          name: 'Custom User Waypoint Title (With Notes)',
          placeName: 'Maverik',
          address: '2701 W Main St, Farmington, NM 87401',
          type: 'fuel',
          dwellMinutes: 15,
        },
      ];

      const url = buildSingleGoogleMapsUrl(origin, dest, intermediate);

      expect(url).toContain(encodeURIComponent('Maverik, 2701 W Main St, Farmington, NM 87401'));
      expect(url).not.toContain('Custom+User+Waypoint+Title');
    });

    it('filters out redundant in-transit audio cues on Day 1 while preserving route-forcing anchor', () => {
      const day1Waypoints: CoordinateLocation[] = [
        {
          lat: 33.4308,
          lng: -112.0444,
          name: 'PHX Rental Car Center',
          type: 'origin',
          dwellMinutes: 0,
        },
        {
          lat: 34.775,
          lng: -111.7635,
          name: 'Sedona Red Rocks Vista',
          type: 'scenic_drive_by',
          dwellMinutes: 0, // In-transit drive-by
        },
        {
          lat: 35.002,
          lng: -111.7375,
          name: 'Oak Creek Canyon Switchbacks',
          type: 'scenic_drive_by',
          dwellMinutes: 0, // Redundant drive-by along same canyon corridor
        },
        {
          lat: 35.028,
          lng: -111.7341,
          name: 'Oak Creek Vista Overlook',
          type: 'scenic_pull_off',
          dwellMinutes: 15, // Physical stop
        },
        {
          lat: 35.1901,
          lng: -111.6207,
          name: 'Flagstaff / Little America Hotel',
          type: 'lodging',
          dwellMinutes: 0,
        },
      ];

      const result = generateGoogleMapsUrls(day1Waypoints);

      expect(result.totalLegs).toBe(1);
      const leg = result.legs[0];

      // Origin, Sedona anchor, Oak Creek Vista, Little America Destination = 4 total points (2 intermediate)
      expect(leg.waypointCount).toBe(4);
      expect(leg.origin.name).toBe('PHX Rental Car Center');
      expect(leg.destination.name).toBe('Flagstaff / Little America Hotel');
      expect(leg.intermediateWaypoints).toHaveLength(2);
      expect(leg.intermediateWaypoints[0].name).toBe('Sedona Red Rocks Vista');
      expect(leg.intermediateWaypoints[1].name).toBe('Oak Creek Vista Overlook');

      // Oak Creek Switchbacks was excluded from Google Maps navigation
      const names = leg.intermediateWaypoints.map((w) => w.name);
      expect(names).not.toContain('Oak Creek Canyon Switchbacks');
    });

    it('honors explicit isRouteAnchor: true to force inclusion and isRouteAnchor: false to force exclusion', () => {
      const waypoints: CoordinateLocation[] = [
        { lat: 33.0, lng: -112.0, name: 'Start', type: 'origin' },
        {
          lat: 34.0,
          lng: -111.5,
          name: 'Scenic Pass 1',
          type: 'scenic_drive_by',
          dwellMinutes: 0,
          isRouteAnchor: false, // Explicitly excluded from Google Maps navigation
        },
        {
          lat: 34.5,
          lng: -111.2,
          name: 'Scenic Pass 2 (Highway Anchor)',
          type: 'scenic_drive_by',
          dwellMinutes: 0,
          isRouteAnchor: true, // Explicitly included in Google Maps navigation
        },
        { lat: 35.0, lng: -111.0, name: 'End', type: 'destination' },
      ];

      const result = generateGoogleMapsUrls(waypoints);

      expect(result.legs[0].intermediateWaypoints).toHaveLength(1);
      expect(result.legs[0].intermediateWaypoints[0].name).toBe('Scenic Pass 2 (Highway Anchor)');
    });

    it('formats destination with clean place name combined with address for rich navigation labeling', () => {
      const origin: CoordinateLocation = {
        lat: 33.4308,
        lng: -112.0444,
        name: 'PHX Rental Car Center',
        address: '1805 E Sky Harbor Cir S, Phoenix, AZ',
        placeId: 'ChIJ-Tj-S_AKK4cR2G-y91c-b-I',
      };
      const dest: CoordinateLocation = {
        lat: 35.1901,
        lng: -111.6207,
        name: 'Flagstaff / Little America Hotel',
        address: '2515 E Butler Ave, Flagstaff, AZ 86004',
        placeId: 'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q',
      };

      const url = buildSingleGoogleMapsUrl(origin, dest, []);

      // Destination query should combine clean establishment name ("Little America Hotel") and address
      expect(url).toContain(encodeURIComponent('Little America Hotel, 2515 E Butler Ave, Flagstaff, AZ 86004'));
      expect(url).toContain('destination_place_id=ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q');
    });

    it('formats in-transit scenic drive-bys and 0-dwell anchors as exact coordinates to prevent Airbnb/side-street detours', () => {
      // Simulates the Sedona Red Rocks Vista issue where an address ("AZ-179, Village of Oak Creek...")
      // previously caused Google Maps to route to a vacation rental Airbnb instead of staying on the highway.
      const origin: CoordinateLocation = {
        lat: 33.4308,
        lng: -112.0444,
        name: 'PHX Rental Car Center',
        address: '1805 E Sky Harbor Cir S, Phoenix, AZ 85034',
        type: 'origin',
      };
      const sedonaAnchor: CoordinateLocation = {
        lat: 34.7865,
        lng: -111.7612,
        name: 'Sedona Red Rocks Vista',
        address: 'AZ-179, Village of Oak Creek, AZ 86351',
        type: 'scenic_drive_by',
        dwellMinutes: 0,
        isRouteAnchor: true,
      };
      const oakCreekVista: CoordinateLocation = {
        lat: 35.0345,
        lng: -111.733,
        name: 'Oak Creek Vista',
        address: 'State, AZ-89A, Flagstaff, AZ 86001',
        type: 'scenic_viewpoint',
        dwellMinutes: 20,
        isRouteAnchor: false,
      };
      const dest: CoordinateLocation = {
        lat: 35.1901,
        lng: -111.6207,
        name: 'Little America Hotel',
        address: '2515 E Butler Ave, Flagstaff, AZ 86004',
        type: 'lodging',
        dwellMinutes: 0,
      };

      const result = generateGoogleMapsUrls([origin, sedonaAnchor, oakCreekVista, dest]);
      expect(result.legs).toHaveLength(1);
      const url = result.legs[0].url;

      // Sedona Red Rocks Vista MUST be formatted as exact coordinates to stay on AZ-179
      expect(url).toContain('34.7865,-111.7612');
      expect(url).not.toContain('Sedona+Red+Rocks+Vista');
      expect(url).not.toContain('Village+of+Oak+Creek');

      // Oak Creek Vista is a physical stop (20m dwell) and SHOULD include its name and address
      expect(url).toContain(encodeURIComponent('Oak Creek Vista, State, AZ-89A, Flagstaff, AZ 86001'));

      // Destination lodging (even with 0m dwell) SHOULD include its name and address
      expect(url).toContain(encodeURIComponent('Little America Hotel, 2515 E Butler Ave, Flagstaff, AZ 86004'));
    });
  });
});
