import React from 'react';
import * as renderer from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RouteScoutDrawer } from './RouteScoutDrawer.js';
import { chatWithScoutStream, fetchScoutQuickPrompts } from '../services/api.js';
import type { ParsedTrip } from '../engine/itineraryParser.js';
import type { ScoutChatRequest, ScoutStreamEvent } from '../types/scout.js';

vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return {
    ...actual,
    createPortal: (children: React.ReactNode) => children,
  };
});

vi.mock('../services/api.js', async () => {
  const actual = await vi.importActual<typeof import('../services/api.js')>('../services/api.js');
  return {
    ...actual,
    fetchScoutQuickPrompts: vi.fn().mockResolvedValue([]),
    chatWithScoutStream: vi.fn(),
  };
});

const act = renderer.act;
const create = renderer.create;

const sampleParsedTrip: ParsedTrip = {
  tripName: 'Arizona Scenic Highway Run',
  days: [
    {
      dayNumber: 1,
      title: 'Day 1: Phoenix to Flagstaff',
      date: '2026-10-10',
      origin: 'Phoenix, AZ',
      destination: 'Flagstaff, AZ',
      departureTime: '08:00:00',
      waypoints: [
        {
          id: 'wp_origin',
          name: 'Phoenix Departure',
          type: 'origin',
          lat: 33.4484,
          lng: -112.074,
          target_time: '08:00:00',
          dwell_minutes: 0,
        },
        {
          id: 'wp_bell_rock',
          name: 'Bell Rock Scenic Vista',
          type: 'scenic_drive_by',
          lat: 34.8005,
          lng: -111.7667,
          target_time: '10:00:00',
          dwell_minutes: 0,
          trigger_radius_miles: 2.0,
          is_route_anchor: true,
          notification: {
            title: 'Approaching Bell Rock',
            message: 'Approaching Bell Rock Vista along AZ-179.',
            speech: 'Approaching Bell Rock Scenic Vista ahead on your left.',
          },
        },
        {
          id: 'wp_sedona_lunch',
          name: 'Sedona Cafe',
          type: 'meal',
          lat: 34.8697,
          lng: -111.761,
          target_time: '10:30:00',
          dwell_minutes: 45,
          place_name: 'Sedona Cafe',
          address: '100 Main St, Sedona, AZ 86336',
          google_place_id: 'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q',
          is_route_anchor: false,
          notification: {
            title: 'Sedona Cafe Ahead',
            message: 'Arriving at Sedona Cafe for lunch.',
            speech: 'Approaching Sedona Cafe ahead for lunch.',
          },
        },
        {
          id: 'wp_dest',
          name: 'Flagstaff Lodging',
          type: 'lodging',
          lat: 35.1983,
          lng: -111.6513,
          target_time: '12:30:00',
          dwell_minutes: 0,
          place_name: 'Flagstaff Motor Inn',
          address: '200 Route 66, Flagstaff, AZ 86001',
          google_place_id: 'ChIJCR3fWhuQO4cRxCLXXbAfCxQ',
          is_route_anchor: false,
        },
      ],
    },
  ],
};

describe('RouteScoutDrawer Suggestion Cards', () => {
  const storageEntries = new Map<string, string>();

  beforeEach(() => {
    storageEntries.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storageEntries.get(key) ?? null,
      setItem: (key: string, value: string) => storageEntries.set(key, value),
      removeItem: (key: string) => storageEntries.delete(key),
    });

    const documentStub = new EventTarget();
    Object.assign(documentStub, {
      body: { style: {} },
    });
    vi.stubGlobal('document', documentStub);

    const windowStub = new EventTarget();
    Object.assign(windowStub, {
      location: { href: 'http://localhost:5173' },
    });
    vi.stubGlobal('window', windowStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('RouteScoutDrawer renders delete_waypoint suggestion card and removes waypoint upon click', async () => {
    const onDeleteWaypoint = vi.fn();

    (chatWithScoutStream as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (_req: ScoutChatRequest, onEvent: (ev: ScoutStreamEvent) => void) => {
        onEvent({
          event: 'suggestions',
          data: {
            suggestions: [
              {
                id: 'sug_del_1',
                action: 'delete_waypoint',
                name: 'Sedona Cafe',
                type: 'meal',
                lat: 34.8697,
                lng: -111.761,
                targetWaypointId: 'wp_sedona_lunch',
                reason: 'Redundant lunch stop.',
              },
            ],
          },
        });
        onEvent({
          event: 'done',
          data: {
            reply: 'I recommend removing Sedona Cafe from the itinerary.',
            suggestions: [
              {
                id: 'sug_del_1',
                action: 'delete_waypoint',
                name: 'Sedona Cafe',
                type: 'meal',
                lat: 34.8697,
                lng: -111.761,
                targetWaypointId: 'wp_sedona_lunch',
                reason: 'Redundant lunch stop.',
              },
            ],
            sessionId: 'scout_test_session',
            engine: 'bedrock',
            modelId: 'us.moonshotai.kimi-k3',
          },
        });
        return {
          reply: 'I recommend removing Sedona Cafe from the itinerary.',
          suggestions: [],
          sessionId: 'scout_test_session',
          engine: 'bedrock',
          modelId: 'us.moonshotai.kimi-k3',
        };
      }
    );

    let app!: ReactTestRenderer;
    await act(async () => {
      app = create(
        <RouteScoutDrawer
          isOpen={true}
          onClose={vi.fn()}
          trip={sampleParsedTrip}
          activeDayIndex={0}
          activeDay={sampleParsedTrip.days[0]}
          waypoints={sampleParsedTrip.days[0].waypoints}
          scope={{ type: 'day', dayNumber: 1 }}
          onChangeScope={vi.fn()}
          onAddWaypoint={vi.fn()}
          onUpdateWaypoint={vi.fn()}
          onDeleteWaypoint={onDeleteWaypoint}
          onPreviewCoordinate={vi.fn()}
          aiAvailable={true}
          aiModels={[{ id: 'us.moonshotai.kimi-k3', name: 'Kimi K3', role: 'both', provider: 'Moonshot AI' }]}
          selectedModelId="us.moonshotai.kimi-k3"
        />
      );
    });

    const textarea = app.root.findByType('textarea');
    await act(async () => {
      textarea.props.onChange({ target: { value: 'Can we remove the lunch stop?' } });
    });

    const form = app.root.findByType('form');
    await act(async () => {
      form.props.onSubmit({ preventDefault: vi.fn() });
    });

    const allSpans = app.root.findAllByType('span');
    const badge = allSpans.find((s) => s.children.includes('Remove Stop'));
    expect(badge).toBeDefined();

    const allButtons = app.root.findAllByType('button');
    const removeButton = allButtons.find((b) => {
      const span = b.findAllByType('span');
      return span.some((s) => s.children.includes('Remove Stop'));
    });
    expect(removeButton).toBeDefined();
    expect(removeButton?.props.disabled).toBe(false);

    await act(async () => {
      removeButton?.props.onClick();
    });

    expect(onDeleteWaypoint).toHaveBeenCalledTimes(1);
    expect(onDeleteWaypoint).toHaveBeenCalledWith('wp_sedona_lunch');

    const updatedButtons = app.root.findAllByType('button');
    const removedButton = updatedButtons.find((b) => {
      const span = b.findAllByType('span');
      return span.some((s) => s.children.includes('Removed ✓'));
    });
    expect(removedButton).toBeDefined();
    expect(removedButton?.props.disabled).toBe(true);
  });
});
