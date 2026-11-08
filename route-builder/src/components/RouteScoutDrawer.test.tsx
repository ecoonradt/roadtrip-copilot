import React from 'react';
import * as renderer from 'react-test-renderer';
import type { ReactTestRenderer, ReactTestInstance } from 'react-test-renderer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RouteScoutDrawer } from './RouteScoutDrawer';
import { chatWithScoutStream } from '../services/api';
import type { Waypoint } from '../types/routing';
import type { ParsedTrip } from '../engine/itineraryParser';
import type {
  ScoutChatRequest,
  ScoutStreamEvent,
  ScoutChatResponse,
} from '../types/scout';
import type { AiModelOption, WaypointContext } from '../types/ai';
import { TEST_MOCK_MODELS, setupBrowserTestGlobals } from '../test-helpers/aiFixtures';

// Mock react-dom createPortal so modal renders inline under react-test-renderer
vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return {
    ...actual,
    createPortal: (children: React.ReactNode) => children,
  };
});

const act = renderer.act;
const create = renderer.create;

const sampleWaypoint: WaypointContext = {
  id: 'wp_sedona_bell_rock',
  name: 'Sedona Red Rock Vistas (Bell Rock)',
  type: 'scenic_pull_off',
  targetTime: '16:30:00',
  formattedTime: '4:30 PM',
  approachHighway: 'AZ-179 North',
  notes: 'Bell Rock scenic pull-off for photo views',
};

const sampleWaypointWithDetails: Waypoint = {
  id: 'wp_sedona_bell_rock',
  name: 'Sedona Red Rock Vistas (Bell Rock)',
  type: 'scenic_pull_off',
  lat: 34.8005,
  lng: -111.7667,
  target_time: '16:30:00',
  dwell_minutes: 20,
  trigger_radius_miles: 2.0,
  approachHighway: 'AZ-179 North',
  notes: 'Bell Rock scenic pull-off for red rock views',
  notification: {
    title: 'Bell Rock Vista Ahead',
    message: 'Arriving at Bell Rock. 20-min scenic stop.',
    speech: 'Approaching Bell Rock Scenic Vista on Highway 179.',
  },
};

const sampleTrip: ParsedTrip = {
  tripName: 'Phoenix to Sedona Scenic Run',
  days: [
    {
      dayNumber: 1,
      title: 'Day 1: Red Rock Scenic Byway',
      date: '2026-10-10',
      origin: 'Phoenix, AZ',
      destination: 'Sedona, AZ',
      departureTime: '08:00:00',
      waypoints: [sampleWaypointWithDetails],
    },
  ],
};

describe('Route Scout Drawer & UI Controls', () => {
  describe('Route Scout model selector and stream lifecycle', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });


    describe('UI Model Selectors', () => {
      const storageEntries = new Map<string, string>();
      const mounted: ReactTestRenderer[] = [];

      beforeEach(() => {
        setupBrowserTestGlobals(storageEntries);
      });

      afterEach(() => {
        for (const inst of mounted) {
          act(() => {
            inst.unmount();
          });
        }
        mounted.length = 0;
      });

      it('renders <RouteScoutDrawer> with Route Scout AI Model selector containing only scout / both models and triggers onChange', () => {
        const onSelectScoutModel = vi.fn();
        let app!: ReactTestRenderer;

        act(() => {
          app = create(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={TEST_MOCK_MODELS}
              selectedModelId="us.moonshotai.kimi-k3"
              onSelectModel={onSelectScoutModel}
            />
          );
        });
        mounted.push(app);

        // Find the select element by aria-label
        const select = app.root.findByProps({ 'aria-label': 'Route Scout AI Model' });
        expect(select).toBeDefined();
        expect(select.props.value).toBe('us.moonshotai.kimi-k3');

        // Verify options contain only scout or both models
        const options = select.findAllByType('option');
        expect(options.length).toBeGreaterThan(0);

        for (const opt of options) {
          const optModelId = opt.props.value;
          const matchingCatalogModel = TEST_MOCK_MODELS.find((m) => m.id === optModelId);
          expect(matchingCatalogModel).toBeDefined();
          expect(['scout', 'both']).toContain(matchingCatalogModel?.role);
        }

        // Trigger change to another model
        act(() => {
          select.props.onChange({ target: { value: 'us.amazon.nova-pro-v1:0' } });
        });

        expect(onSelectScoutModel).toHaveBeenCalledTimes(1);
        expect(onSelectScoutModel).toHaveBeenCalledWith('us.amazon.nova-pro-v1:0');
      });


      it('renders disabled "Select model..." option and does not silently fall back to first model when selectedModelId is empty', () => {
        let app!: ReactTestRenderer;

        act(() => {
          app = create(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={TEST_MOCK_MODELS}
              selectedModelId=""
            />
          );
        });
        mounted.push(app);

        const select = app.root.findByProps({ 'aria-label': 'Route Scout AI Model' });
        expect(select.props.value).toBe('');
        const options = select.findAllByType('option');
        const placeholderOption = options.find((opt) => opt.props.value === '');
        expect(placeholderOption).toBeDefined();
        expect(placeholderOption?.props.disabled).toBe(true);
      });

      it('isolates conversations across itineraries: aborts in-flight stream and prevents Trip A results leaking into Trip B', async () => {
        let capturedSignal: AbortSignal | undefined;
        let resolveStreamPromise!: () => void;

        vi.stubGlobal(
          'fetch',
          vi.fn().mockImplementation((url: string, init?: RequestInit) => {
            if (url.includes('/api/ai/scout/quick-prompts')) {
              return Promise.resolve({
                ok: true,
                json: async () => ['Prompt 1', 'Prompt 2'],
              });
            }
            if (url.includes('/api/ai/scout/chat/stream')) {
              capturedSignal = init?.signal;
              return new Promise((resolve) => {
                resolveStreamPromise = () => {
                  const encoder = new TextEncoder();
                  const stream = new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(
                        encoder.encode('event: delta\ndata: {"text":"Advice intended solely for Trip A"}\n\n')
                      );
                      controller.enqueue(
                        encoder.encode(
                          'event: done\ndata: {"reply":"Advice intended solely for Trip A","suggestions":[],"sessionId":"s1"}\n\n'
                        )
                      );
                      controller.close();
                    },
                  });
                  resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'text/event-stream' }),
                    body: stream,
                  });
                };
              });
            }
            return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
          })
        );

        let drawer!: ReactTestRenderer;
        const tripA = { ...sampleTrip, fileName: 'trip-a.json', tripName: 'Trip A' };
        const tripB = { ...sampleTrip, fileName: 'trip-b.json', tripName: 'Trip B' };

        act(() => {
          drawer = create(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={tripA}
              itineraryId="trip-a"
              activeDayIndex={0}
              activeDay={tripA.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={TEST_MOCK_MODELS}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });
        mounted.push(drawer);

        // Start a turn for Trip A
        const form = drawer.root.findByType('form');
        const textarea = drawer.root.findByType('textarea');
        act(() => {
          textarea.props.onChange({ target: { value: 'Recommend fuel stops along I-40 for Trip A' } });
        });
        act(() => {
          form.props.onSubmit({ preventDefault: () => {} });
        });

        expect(capturedSignal).toBeDefined();
        expect(capturedSignal?.aborted).toBe(false);

        // Trip A stream is now deferred and in flight. Switch component props to Trip B:
        act(() => {
          drawer.update(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={tripB}
              itineraryId="trip-b"
              activeDayIndex={0}
              activeDay={tripB.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={TEST_MOCK_MODELS}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });

        // 1. Verify Trip A's stream abort signal was triggered upon itinerary switch
        expect(capturedSignal?.aborted).toBe(true);

        // 2. Now let Trip A's deferred stream complete
        await act(async () => {
          resolveStreamPromise();
        });

        // 3. Verify Trip B does NOT render Trip A's deferred response
        const jsonTree = JSON.stringify(drawer.toJSON());
        expect(jsonTree).not.toContain('Advice intended solely for Trip A');
      });

      it('aborts active stream when drawer is closed (isOpen becomes false)', () => {
        let capturedSignal: AbortSignal | undefined;

        vi.stubGlobal(
          'fetch',
          vi.fn().mockImplementation((url: string, init?: RequestInit) => {
            if (url.includes('/api/ai/scout/quick-prompts')) {
              return Promise.resolve({ ok: true, json: async () => [] });
            }
            if (url.includes('/api/ai/scout/chat/stream')) {
              capturedSignal = init?.signal;
              return new Promise(() => {}); // never resolves
            }
            return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
          })
        );

        let drawer!: ReactTestRenderer;
        act(() => {
          drawer = create(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={TEST_MOCK_MODELS}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });
        mounted.push(drawer);

        const form = drawer.root.findByType('form');
        const textarea = drawer.root.findByType('textarea');
        act(() => {
          textarea.props.onChange({ target: { value: 'In flight request' } });
        });
        act(() => {
          form.props.onSubmit({ preventDefault: () => {} });
        });

        expect(capturedSignal).toBeDefined();
        expect(capturedSignal?.aborted).toBe(false);

        // Close the drawer
        act(() => {
          drawer.update(
            <RouteScoutDrawer
              isOpen={false}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={TEST_MOCK_MODELS}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });

        expect(capturedSignal?.aborted).toBe(true);

        // Reopen the drawer: verify no stuck analyzing placeholder message is retained (R7)
        act(() => {
          drawer.update(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={TEST_MOCK_MODELS}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });

        const reopenedJson = JSON.stringify(drawer.toJSON());
        expect(reopenedJson).not.toContain('Route Scout is analyzing route geometry & corridor');
      });

      it('aborts active stream when scope is switched', () => {
        let capturedSignal: AbortSignal | undefined;

        vi.stubGlobal(
          'fetch',
          vi.fn().mockImplementation((url: string, init?: RequestInit) => {
            if (url.includes('/api/ai/scout/quick-prompts')) {
              return Promise.resolve({ ok: true, json: async () => [] });
            }
            if (url.includes('/api/ai/scout/chat/stream')) {
              capturedSignal = init?.signal;
              return new Promise(() => {}); // never resolves
            }
            return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
          })
        );

        let drawer!: ReactTestRenderer;
        act(() => {
          drawer = create(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={TEST_MOCK_MODELS}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });
        mounted.push(drawer);

        const form = drawer.root.findByType('form');
        const textarea = drawer.root.findByType('textarea');
        act(() => {
          textarea.props.onChange({ target: { value: 'In flight request' } });
        });
        act(() => {
          form.props.onSubmit({ preventDefault: () => {} });
        });

        expect(capturedSignal).toBeDefined();
        expect(capturedSignal?.aborted).toBe(false);

        // Switch scope to Day 2
        act(() => {
          drawer.update(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={1}
              activeDay={sampleTrip.days[1] || sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 2 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={TEST_MOCK_MODELS}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });

        expect(capturedSignal?.aborted).toBe(true);

        // Switch scope back to Day 1: verify no stuck analyzing placeholder is retained (R7)
        act(() => {
          drawer.update(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={TEST_MOCK_MODELS}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });

        const day1Json = JSON.stringify(drawer.toJSON());
        expect(day1Json).not.toContain('Route Scout is analyzing route geometry & corridor');
      });

      it('preserves completed suggestions-only message across drawer close/reopen and scope switch (P2 Finding 4)', async () => {
        let resolveStreamPromise: () => void = () => {};

        vi.stubGlobal(
          'fetch',
          vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/ai/scout/quick-prompts')) {
              return Promise.resolve({
                ok: true,
                json: async () => [],
              });
            }
            if (url.includes('/api/ai/scout/chat/stream')) {
              return new Promise((resolve) => {
                resolveStreamPromise = () => {
                  const encoder = new TextEncoder();
                  const stream = new ReadableStream<Uint8Array>({
                    start(controller) {
                      const suggestionsBlock = JSON.stringify({
                        reply: '',
                        suggestions: [
                          {
                            id: 'sug-scenic-1',
                            action: 'add_waypoint',
                            name: 'Completed Scenic Vista',
                            type: 'scenic',
                            lat: 34.8697,
                            lng: -111.761,
                            notes: 'Must-see red rocks vista',
                            reason: 'Iconic panoramic viewpoint along corridor',
                          },
                        ],
                        sessionId: 's_test_123',
                        engine: 'bedrock',
                      });
                      controller.enqueue(
                        encoder.encode(`event: done\ndata: ${suggestionsBlock}\n\n`)
                      );
                      controller.close();
                    },
                  });
                  resolve({
                    ok: true,
                    status: 200,
                    headers: new Headers({ 'content-type': 'text/event-stream' }),
                    body: stream,
                  });
                };
              });
            }
            return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
          })
        );

        let drawer!: ReactTestRenderer;
        act(() => {
          drawer = create(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={TEST_MOCK_MODELS}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });
        mounted.push(drawer);

        const form = drawer.root.findByType('form');
        const textarea = drawer.root.findByType('textarea');
        act(() => {
          textarea.props.onChange({ target: { value: 'Suggest scenic spots' } });
        });
        act(() => {
          form.props.onSubmit({ preventDefault: () => {} });
        });

        // Resolve the streaming response
        await act(async () => {
          resolveStreamPromise();
        });

        // The completed suggestion card is rendered
        let jsonStr = JSON.stringify(drawer.toJSON());
        expect(jsonStr).toContain('Completed Scenic Vista');

        // Close the drawer and reopen: verify completed suggestion card is preserved
        act(() => {
          drawer.update(
            <RouteScoutDrawer
              isOpen={false}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={TEST_MOCK_MODELS}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });
        act(() => {
          drawer.update(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={TEST_MOCK_MODELS}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });
        jsonStr = JSON.stringify(drawer.toJSON());
        expect(jsonStr).toContain('Completed Scenic Vista');

        // Switch scope to Day 2 and return to Day 1: verify completed suggestion card is preserved
        act(() => {
          drawer.update(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={1}
              activeDay={sampleTrip.days[1] || sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 2 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={TEST_MOCK_MODELS}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });
        act(() => {
          drawer.update(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={TEST_MOCK_MODELS}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });
        jsonStr = JSON.stringify(drawer.toJSON());
        expect(jsonStr).toContain('Completed Scenic Vista');
      });

      it('preserves completed cards-only answer without duplicate loading indicator during follow-up turn (P3 Finding 2)', async () => {
        let streamCount = 0;
        let resolveFirstStream: () => void = () => {};

        vi.stubGlobal(
          'fetch',
          vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/ai/scout/quick-prompts')) {
              return Promise.resolve({
                ok: true,
                json: async () => [],
              });
            }
            if (url.includes('/api/ai/scout/chat/stream')) {
              streamCount++;
              if (streamCount === 1) {
                return new Promise((resolve) => {
                  resolveFirstStream = () => {
                    const encoder = new TextEncoder();
                    const stream = new ReadableStream<Uint8Array>({
                      start(controller) {
                        const suggestionsBlock = JSON.stringify({
                          reply: '',
                          suggestions: [
                            {
                              id: 'sug-scenic-1',
                              action: 'add_waypoint',
                              name: 'Completed Scenic Vista',
                              type: 'scenic',
                              lat: 34.8697,
                              lng: -111.761,
                              notes: 'Must-see red rocks vista',
                              reason: 'Iconic panoramic viewpoint along corridor',
                            },
                          ],
                          sessionId: 's_test_123',
                          engine: 'bedrock',
                        });
                        controller.enqueue(
                          encoder.encode(`event: done\ndata: ${suggestionsBlock}\n\n`)
                        );
                        controller.close();
                      },
                    });
                    resolve({
                      ok: true,
                      status: 200,
                      headers: new Headers({ 'content-type': 'text/event-stream' }),
                      body: stream,
                    });
                  };
                });
              }
              // Second stream (follow-up turn) stays deferred / in flight
              return new Promise(() => {});
            }
            return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
          })
        );

        let drawer!: ReactTestRenderer;
        act(() => {
          drawer = create(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={TEST_MOCK_MODELS}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });
        mounted.push(drawer);

        // Turn 1
        const form = drawer.root.findByType('form');
        const textarea = drawer.root.findByType('textarea');
        act(() => {
          textarea.props.onChange({ target: { value: 'Suggest scenic spots' } });
        });
        act(() => {
          form.props.onSubmit({ preventDefault: () => {} });
        });

        // Resolve Turn 1 stream
        await act(async () => {
          resolveFirstStream();
        });

        // Completed card is rendered, no loading indicators
        let jsonStr = JSON.stringify(drawer.toJSON());
        expect(jsonStr).toContain('Completed Scenic Vista');
        expect(jsonStr).not.toContain('Route Scout is analyzing route geometry & corridor');

        // Start Turn 2 (deferred follow-up turn)
        act(() => {
          textarea.props.onChange({ target: { value: 'Any coffee spots nearby?' } });
        });
        act(() => {
          form.props.onSubmit({ preventDefault: () => {} });
        });

        // Assert: Turn 2 in-flight turn renders EXACTLY ONE loading indicator, and Turn 1's completed card remains
        jsonStr = JSON.stringify(drawer.toJSON());
        expect(jsonStr).toContain('Completed Scenic Vista');
        const matches = jsonStr.match(/Route Scout is analyzing route geometry & corridor/g);
        expect(matches).toHaveLength(1);

        // Close the drawer to cancel the active turn
        act(() => {
          drawer.update(
            <RouteScoutDrawer
              isOpen={false}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={TEST_MOCK_MODELS}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });

        // Reopen drawer: Turn 2's placeholder was removed, Turn 1's completed card is preserved, and 0 loading indicators
        act(() => {
          drawer.update(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={TEST_MOCK_MODELS}
              selectedModelId="us.moonshotai.kimi-k3"
            />
          );
        });

        jsonStr = JSON.stringify(drawer.toJSON());
        expect(jsonStr).toContain('Completed Scenic Vista');
        expect(jsonStr).not.toContain('Route Scout is analyzing route geometry & corridor');
      });

      it('gates Route Scout input, send button, and quick prompts when selectedModelId is empty (R5)', () => {
        let drawer!: ReactTestRenderer;
        act(() => {
          drawer = create(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              itineraryId="trip-sample"
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={TEST_MOCK_MODELS}
              selectedModelId=""
            />
          );
        });
        mounted.push(drawer);

        const textarea = drawer.root.findByType('textarea');
        expect(textarea.props.disabled).toBe(true);
        expect(textarea.props.placeholder).toContain('Select an AI model');

        const sendButton = drawer.root.findByProps({ type: 'submit' });
        expect(sendButton.props.disabled).toBe(true);

        const select = drawer.root.findByType('select');
        expect(select.props.value).toBe('');
      });

      it('renders delete_waypoint suggestion card and removes waypoint upon click', async () => {
        const onDeleteWaypoint = vi.fn();

        vi.stubGlobal(
          'fetch',
          vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/ai/scout/quick-prompts')) {
              return Promise.resolve({ ok: true, json: async () => [] });
            }
            if (url.includes('/api/ai/scout/chat/stream')) {
              const encoder = new TextEncoder();
              const suggestionsBlock = JSON.stringify({
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
              });
              const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    encoder.encode(`event: done\ndata: ${suggestionsBlock}\n\n`)
                  );
                  controller.close();
                },
              });
              return Promise.resolve({
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'text/event-stream' }),
                body: stream,
              });
            }
            return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
          })
        );

        const tripWithLunch: ParsedTrip = {
          tripName: 'Arizona Scenic Run',
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
                  id: 'wp_sedona_lunch',
                  name: 'Sedona Cafe',
                  type: 'meal',
                  lat: 34.8697,
                  lng: -111.761,
                  target_time: '10:30:00',
                  dwell_minutes: 45,
                  place_name: 'Sedona Cafe',
                  address: '100 Main St, Sedona, AZ 86336',
                  is_route_anchor: false,
                },
                {
                  id: 'wp_dest',
                  name: 'Flagstaff Lodging',
                  type: 'lodging',
                  lat: 35.1983,
                  lng: -111.6513,
                  target_time: '12:30:00',
                  dwell_minutes: 0,
                  is_route_anchor: false,
                },
              ],
            },
          ],
        };

        let drawer!: ReactTestRenderer;
        await act(async () => {
          drawer = create(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={tripWithLunch}
              activeDayIndex={0}
              activeDay={tripWithLunch.days[0]}
              waypoints={tripWithLunch.days[0].waypoints}
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
        mounted.push(drawer);

        const textarea = drawer.root.findByType('textarea');
        await act(async () => {
          textarea.props.onChange({ target: { value: 'Can we remove the lunch stop?' } });
        });

        const form = drawer.root.findByType('form');
        await act(async () => {
          form.props.onSubmit({ preventDefault: vi.fn() });
        });

        const allSpans = drawer.root.findAllByType('span');
        const badge = allSpans.find((s) => s.children.includes('Remove Stop'));
        expect(badge).toBeDefined();

        const allButtons = drawer.root.findAllByType('button');
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

        const updatedButtons = drawer.root.findAllByType('button');
        const removedButton = updatedButtons.find((b) => {
          const span = b.findAllByType('span');
          return span.some((s) => s.children.includes('Removed ✓'));
        });
        expect(removedButton).toBeDefined();
        expect(removedButton?.props.disabled).toBe(true);
      });


    });
  });
});

