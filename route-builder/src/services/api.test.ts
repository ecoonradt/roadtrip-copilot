import { describe, it, expect, vi, afterEach } from 'vitest';
import { chatWithScoutStream } from './api';
import type {
  ScoutStreamEvent,
  ScoutChatRequest,
  ScoutChatResponse,
  ScoutTripContext,
} from '../types/scout';

const sampleTripContext: ScoutTripContext = {
  tripName: 'Phoenix to Sedona Scenic Run',
  date: '2026-10-10',
  origin: 'Phoenix, AZ',
  destination: 'Sedona, AZ',
  departureTime: '08:00:00',
  corridor: 'I-17 N to AZ-179 N Red Rock Scenic Byway',
  waypoints: [
    {
      id: 'wp_origin',
      name: 'Phoenix Origin',
      type: 'origin',
      lat: 33.4484,
      lng: -112.074,
      target_time: '08:00:00',
      dwell_minutes: 0,
    },
    {
      id: 'wp_sedona_bell_rock',
      name: 'Bell Rock Scenic Vista',
      type: 'scenic_pull_off',
      lat: 34.8005,
      lng: -111.7667,
      target_time: '10:00:00',
      dwell_minutes: 20,
    },
    {
      id: 'wp_dest',
      name: 'Sedona Lodging',
      type: 'lodging',
      lat: 34.8697,
      lng: -111.761,
      target_time: '12:00:00',
      dwell_minutes: 0,
    },
  ],
};

describe('Client SSE Parser (chatWithScoutStream)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('chatWithScoutStream cleanly ignores : ping and : keep-alive frames and emits thought, delta, and done', async () => {
    const encoder = new TextEncoder();
    const mockStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': ping\n\n'));
        controller.enqueue(encoder.encode(': keep-alive\n\n'));
        controller.enqueue(
          encoder.encode('event: thought\ndata: {"text":"Reasoning about fuel stops..."}\n\n')
        );
        controller.enqueue(
          encoder.encode('event: delta\ndata: {"text":"Found Maverik at exit 285."}\n\n')
        );
        controller.enqueue(
          encoder.encode(
            'event: done\ndata: {"reply":"Found Maverik at exit 285.","suggestions":[],"sessionId":"s_test_123","engine":"bedrock","modelId":"us.moonshotai.kimi-k3"}\n\n'
          )
        );
        controller.close();
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: mockStream,
      })
    );

    const emittedEvents: ScoutStreamEvent[] = [];
    const onEvent = vi.fn((evt: ScoutStreamEvent) => emittedEvents.push(evt));

    const request: ScoutChatRequest = {
      scope: { type: 'day', dayNumber: 1 },
      messages: [{ role: 'user', content: 'Find fuel' }],
      tripContext: sampleTripContext,
    };

    const response: ScoutChatResponse = await chatWithScoutStream(request, onEvent);

    expect(response).toEqual({
      reply: 'Found Maverik at exit 285.',
      suggestions: [],
      sessionId: 's_test_123',
      engine: 'bedrock',
      modelId: 'us.moonshotai.kimi-k3',
    });

    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(emittedEvents[0]).toEqual({
      event: 'thought',
      data: { text: 'Reasoning about fuel stops...' },
    });
    expect(emittedEvents[1]).toEqual({
      event: 'delta',
      data: { text: 'Found Maverik at exit 285.' },
    });
    expect(emittedEvents[2]).toEqual({
      event: 'done',
      data: response,
    });
  });
});
