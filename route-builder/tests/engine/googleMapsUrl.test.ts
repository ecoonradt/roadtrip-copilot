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
});
