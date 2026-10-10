import React from 'react';
import * as renderer from 'react-test-renderer';
import { describe, it, expect, vi } from 'vitest';
import { TimelineSidebar } from '../../src/components/TimelineSidebar';
import { calculateTimelineCascade } from '../../src/engine/cascade';
import type { Waypoint } from '../../src/types/routing';

describe('TimelineSidebar estimated arrival time (ETA) display', () => {
  const waypoints: Waypoint[] = [
    {
      id: 'wp_phx',
      name: 'PHX Rental Car Facility',
      type: 'origin',
      lat: 33.4357,
      lng: -112.0152,
      dwell_minutes: 0,
      trigger_radius_miles: 0.5,
    },
    {
      id: 'wp_sedona',
      name: 'Sedona Red Rock Vistas',
      type: 'scenic_pull_off',
      lat: 34.801,
      lng: -111.7645,
      dwell_minutes: 30,
      trigger_radius_miles: 2.0,
    },
    {
      id: 'wp_flagstaff',
      name: 'Flagstaff Historic Downtown',
      type: 'destination',
      lat: 35.1982,
      lng: -111.6465,
      dwell_minutes: 0,
      trigger_radius_miles: 1.0,
    },
  ];

  it('renders explicit Dep for origin and ETA for intermediate & final stops with fixed departure schedule', () => {
    // Forward cascade with fixed departure time 14:30
    const cascadeResult = calculateTimelineCascade({
      baseDate: '2026-10-09',
      departureTime: '14:30:00',
      defaultTimezone: 'America/Phoenix',
      waypoints,
      driveDurationsSeconds: [6300, 3000], // 1h 45m and 50m
      driveDistancesMiles: [115, 30],
      isAdHoc: false,
    });

    let component: renderer.ReactTestRenderer | null = null;
    renderer.act(() => {
      component = renderer.create(
        <TimelineSidebar
          waypoints={waypoints}
          cascadeResult={cascadeResult}
          isLoadingRoute={false}
          onDeleteWaypoint={vi.fn()}
          onUpdateWaypoint={vi.fn()}
          onMoveWaypoint={vi.fn()}
          onResetSample={vi.fn()}
          onClearAll={vi.fn()}
          onSelectLocation={vi.fn()}
        />
      );
    });

    const tree = JSON.stringify(component!.toJSON());

    // Origin card displays Departure time (Dep 2:30 PM)
    expect(tree).toContain('Dep');
    expect(tree).toContain('2:30 PM');

    // Intermediate stop displays ETA (ETA 4:15 PM) and Departure after 30m dwell (Dep 4:45 PM)
    expect(tree).toContain('ETA');
    expect(tree).toContain('4:15 PM');
    expect(tree).toContain('4:45 PM');
    expect(tree).toContain('m dwell');

    // Destination card displays ETA (ETA 5:35 PM) and final stop tag
    expect(tree).toContain('5:35 PM');
    expect(tree).toContain('Final Stop');
  });

  it('renders relative offsets cleanly in ad-hoc mode without misleading ETA text', () => {
    const cascadeResult = calculateTimelineCascade({
      baseDate: '2026-10-09',
      departureTime: '09:00:00',
      defaultTimezone: 'America/Phoenix',
      waypoints,
      driveDurationsSeconds: [6300, 3000],
      driveDistancesMiles: [115, 30],
      isAdHoc: true,
    });

    let component: renderer.ReactTestRenderer | null = null;
    renderer.act(() => {
      component = renderer.create(
        <TimelineSidebar
          waypoints={waypoints}
          cascadeResult={cascadeResult}
          isLoadingRoute={false}
          onDeleteWaypoint={vi.fn()}
          onUpdateWaypoint={vi.fn()}
          onMoveWaypoint={vi.fn()}
          onResetSample={vi.fn()}
          onClearAll={vi.fn()}
          onSelectLocation={vi.fn()}
        />
      );
    });

    const tree = JSON.stringify(component!.toJSON());

    // In ad-hoc mode, origin shows 'Start', not 'Dep'
    expect(tree).toContain('Start');
    expect(tree).toContain('+1h 45m');
    expect(tree).toContain('+2h 15m');
    expect(tree).toContain('m dwell');
  });
});
