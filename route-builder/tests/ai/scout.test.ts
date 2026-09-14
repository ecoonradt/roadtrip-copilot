import { describe, it, expect } from 'vitest';
import {
  buildScoutPrompt,
  parseScoutResponse,
  generateTemplateScoutResponse,
  getQuickPrompts,
  ScoutService,
} from '../../server/services/scoutService.js';
import { createApp } from '../../server/app.js';
import type { ScoutChatRequest, ScoutScope, ScoutTripContext } from '../../server/types/scout.js';

describe('Route Scout Service & Prompts', () => {
  const sampleTripContext: ScoutTripContext = {
    tripName: 'Phoenix to Albuquerque Road Trip',
    date: '2026-10-10',
    origin: 'Flagstaff, AZ',
    destination: 'Chama, NM',
    departureTime: '07:30:00',
    corridor: 'I-40 E to US-491 N through Navajo Nation to US-64 E',
    waypoints: [
      {
        id: 'wp_depart',
        name: 'Little America Hotel Flagstaff',
        type: 'origin',
        lat: 35.1878,
        lng: -111.6152,
        target_time: '07:30:00',
        dwell_minutes: 0,
      },
      {
        id: 'wp_shiprock',
        name: 'Shiprock Peak (US-491)',
        type: 'scenic_pull_off',
        lat: 36.6872,
        lng: -108.6875,
        target_time: '12:30:00',
        dwell_minutes: 20,
        trigger_radius_miles: 6.0,
        notes: 'View from highway only (sacred tribal land)',
        notification: {
          title: 'Shiprock Landmark Ahead',
          message: '1,583-ft volcanic peak visible for miles.',
          speech: 'Upcoming sight on your left: Shiprock Peak.',
        },
      },
      {
        id: 'wp_arrive',
        name: 'Vista Del Rio Lodge Chama',
        type: 'lodging',
        lat: 36.8833,
        lng: -106.5828,
        target_time: '17:00:00',
        dwell_minutes: 0,
      },
    ],
  };

  describe('Prompt Construction', () => {
    it('builds comprehensive Day Scope prompt with full itinerary context', () => {
      const scope: ScoutScope = {
        type: 'day',
        dayNumber: 2,
        dayTitle: 'Navajo Nation Transit',
      };
      const request: ScoutChatRequest = {
        scope,
        messages: [{ role: 'user', content: 'Where should we stop for lunch along this 6-hour leg?' }],
        tripContext: sampleTripContext,
      };

      const prompt = buildScoutPrompt(request);
      expect(prompt).toContain('ACTIVE SCOPE: Day 2 (Navajo Nation Transit)');
      expect(prompt).toContain('Flagstaff, AZ');
      expect(prompt).toContain('Chama, NM');
      expect(prompt).toContain('Little America Hotel Flagstaff');
      expect(prompt).toContain('Shiprock Peak');
      expect(prompt).toContain('Where should we stop for lunch along this 6-hour leg?');
    });

    it('builds focused Waypoint Scope prompt with audit and coordinate context', () => {
      const scope: ScoutScope = {
        type: 'waypoint',
        waypointId: 'wp_shiprock',
      };
      const request: ScoutChatRequest = {
        scope,
        messages: [{ role: 'user', content: 'Is this pin on the paved highway or on dirt?' }],
        tripContext: sampleTripContext,
      };

      const prompt = buildScoutPrompt(request);
      expect(prompt).toContain('ACTIVE SCOPE: Waypoint Audit & Refinement');
      expect(prompt).toContain('FOCUSED WAYPOINT DETAILS');
      expect(prompt).toContain('Shiprock Peak (US-491)');
      expect(prompt).toContain('36.687200, -108.687500');
      expect(prompt).toContain('View from highway only (sacred tribal land)');
      expect(prompt).toContain('Is this pin on the paved highway or on dirt?');
    });
  });

  describe('Structured Suggestion Parsing', () => {
    it('extracts conversational prose and add_waypoint suggestion card', () => {
      const rawModelOutput = `I recommend stopping at the historic Cameron Trading Post along US-89. It has fantastic Navajo tacos and clean restrooms.

\`\`\`json:suggestions
[
  {
    "action": "add_waypoint",
    "name": "Cameron Trading Post (Navajo Taco Lunch)",
    "type": "meal",
    "lat": 35.8756,
    "lng": -111.4128,
    "dwell_minutes": 45,
    "trigger_radius_miles": 2.0,
    "reason": "Historic 1916 trading post right on US-89 with great dining."
  }
]
\`\`\``;

      const { reply, suggestions } = parseScoutResponse(rawModelOutput);
      expect(reply).toContain('I recommend stopping at the historic Cameron Trading Post');
      expect(reply).not.toContain('```json:suggestions');
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].action).toBe('add_waypoint');
      expect(suggestions[0].name).toBe('Cameron Trading Post (Navajo Taco Lunch)');
      expect(suggestions[0].type).toBe('meal');
      expect(suggestions[0].lat).toBe(35.8756);
      expect(suggestions[0].lng).toBe(-111.4128);
      expect(suggestions[0].dwell_minutes).toBe(45);
    });

    it('extracts update_waypoint suggestion for coordinate correction', () => {
      const rawModelOutput = `Your current pin for Shiprock Peak is located 8 miles west of the highway on tribal land. I suggest shifting the coordinate to the paved highway pull-off.

\`\`\`json:suggestions
[
  {
    "action": "update_waypoint",
    "targetWaypointId": "wp_shiprock",
    "name": "Shiprock Highway Scenic Viewpoint",
    "type": "scenic_pull_off",
    "lat": 36.6853,
    "lng": -108.6921,
    "dwell_minutes": 15,
    "reason": "Relocate pin to paved pull-off on US-491."
  }
]
\`\`\``;

      const { reply, suggestions } = parseScoutResponse(rawModelOutput);
      expect(reply).toContain('Your current pin for Shiprock Peak is located');
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].action).toBe('update_waypoint');
      expect(suggestions[0].targetWaypointId).toBe('wp_shiprock');
      expect(suggestions[0].lat).toBe(36.6853);
      expect(suggestions[0].lng).toBe(-108.6921);
    });

    it('gracefully returns clean prose when no suggestions block is present', () => {
      const rawOutput = 'The timing on this leg looks fantastic! 7:30 AM departure gives you plenty of daylight.';
      const { reply, suggestions } = parseScoutResponse(rawOutput);
      expect(reply).toBe(rawOutput);
      expect(suggestions).toEqual([]);
    });
  });

  describe('Deterministic Fallback & Quick Prompts', () => {
    it('provides regional dining fallback for day scope', () => {
      const request: ScoutChatRequest = {
        scope: { type: 'day', dayNumber: 2 },
        messages: [{ role: 'user', content: 'Where can we eat lunch?' }],
        tripContext: sampleTripContext,
      };

      const result = generateTemplateScoutResponse(request);
      expect(result.reply).toContain('Mid-Route Dining Recommendations');
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].type).toBe('meal');
    });

    it('provides accessibility guidance fallback for waypoint scope', () => {
      const request: ScoutChatRequest = {
        scope: { type: 'waypoint', waypointId: 'wp_shiprock' },
        messages: [{ role: 'user', content: 'What is parking like here?' }],
        tripContext: sampleTripContext,
      };

      const result = generateTemplateScoutResponse(request);
      expect(result.reply).toContain('Waypoint Accessibility: Shiprock Peak');
    });

    it('returns quick prompts appropriate to the scope', () => {
      const dayPrompts = getQuickPrompts({ type: 'day', dayNumber: 1 });
      expect(dayPrompts.length).toBeGreaterThan(2);
      expect(dayPrompts[0]).toContain('lunch');

      const wpPrompts = getQuickPrompts({ type: 'waypoint', waypointId: 'wp_1' });
      expect(wpPrompts.length).toBeGreaterThan(2);
      expect(wpPrompts[0]).toContain('coordinate');
    });
  });

  describe('Route Scout HTTP API Routes', () => {
    const app = createApp();

    it('POST /api/ai/scout/chat returns 200 with reply and suggestions', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat',
        payload: {
          scope: { type: 'day', dayNumber: 2 },
          messages: [{ role: 'user', content: 'Where should we eat lunch?' }],
          tripContext: sampleTripContext,
          preferredEngine: 'template',
        },
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data).toHaveProperty('reply');
      expect(data).toHaveProperty('suggestions');
      expect(data).toHaveProperty('sessionId');
      expect(data.engine).toBe('template');
    });

    it('POST /api/ai/scout/chat rejects invalid payload with 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat',
        payload: {
          // missing scope & messages
        },
      });
      expect(response.statusCode).toBe(400);
    });

    it('GET /api/ai/scout/quick-prompts returns contextual prompt suggestions', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/ai/scout/quick-prompts?type=day&dayNumber=2',
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(Array.isArray(data.prompts)).toBe(true);
      expect(data.prompts.length).toBeGreaterThan(0);
    });

    it('GET /api/ai/scout/quick-prompts returns waypoint-specific prompts for waypoint scope', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/ai/scout/quick-prompts?type=waypoint&waypointName=Shiprock%20Peak',
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(Array.isArray(data.prompts)).toBe(true);
      expect(data.prompts.some((p: string) => p.includes('Shiprock Peak'))).toBe(true);
    });

    it('POST /api/ai/scout/chat handles waypoint audit query and returns audit advice', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat',
        payload: {
          scope: { type: 'waypoint', waypointId: 'wp_shiprock' },
          messages: [{ role: 'user', content: 'Can we park and hike here or is it sacred Navajo land?' }],
          tripContext: sampleTripContext,
          preferredEngine: 'template',
        },
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.reply).toBeTruthy();
      expect(data.engine).toBe('template');
    });
  });
});
