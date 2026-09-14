import { describe, it, expect } from 'vitest';
import {
  buildScoutDomainPrompt,
  buildScoutPrompt,
  parseScoutResponse,
  generateTemplateScoutResponse,
  getQuickPrompts,
  ScoutService,
  sanitizeScoutReply,
} from '../../server/services/scoutService.js';
import { AgyHarnessAdapter, GeminiStudioHarnessAdapter } from '../../server/services/aiService.js';
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

  describe('Prompt Construction & Adapter Seam', () => {
    it('builds pure domain prompt free of harness-specific directives', () => {
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

      const domainPrompt = buildScoutDomainPrompt(request);
      expect(domainPrompt).toContain('MISSION & ROLE:');
      expect(domainPrompt).toContain('Flagstaff, AZ');
      expect(domainPrompt).toContain('Shiprock Peak');
      // Must not contain harness-specific tool bans or terminal rules
      expect(domainPrompt).not.toContain('CRITICAL OPERATIONAL HARNESS DIRECTIVES');
      expect(domainPrompt).not.toContain('search_web');
      expect(domainPrompt).not.toContain('DO NOT invoke any tools');
      expect(domainPrompt).not.toContain('background tasks');
      expect(domainPrompt).not.toContain('without invoking any tools');
    });

    it('domain prompt explicitly specifies highway alignment, commercial fuel stops, and scenic trigger guidelines', () => {
      const scope: ScoutScope = {
        type: 'day',
        dayNumber: 2,
      };
      const request: ScoutChatRequest = {
        scope,
        messages: [{ role: 'user', content: 'Audit my route waypoints' }],
        tripContext: sampleTripContext,
      };

      const domainPrompt = buildScoutDomainPrompt(request);
      expect(domainPrompt).toContain('DRIVE-BY WAYPOINTS MUST NEVER LEAVE THE HIGHWAY');
      expect(domainPrompt).toContain('highway centerline');
      expect(domainPrompt).toContain('FUEL STOPS MUST BE VERIFIED COMMERCIAL SERVICE STATIONS');
      expect(domainPrompt).toContain('NEVER suggest or accept coordinates in residential neighborhoods, trailer parks');
      expect(domainPrompt).toContain('LOCATION TYPES (PHYSICAL STOPS VS IN-TRANSIT SCENIC TRIGGERS)');
      expect(domainPrompt).toContain('SCENIC DRIVE-BY PLACEMENT & DECOUPLING TITLES FROM SCENIC INTENT');
      expect(domainPrompt).toContain('ROUTE AUDITING & REPAIR');
      expect(domainPrompt).toContain('SYNCHRONIZE WAYPOINT ID, HEADS-UP NOTIFICATION & VOICE ALERT COPY');
      expect(domainPrompt).toContain('newId');
      expect(domainPrompt).toContain('CRITICAL NOTIFICATION CONSISTENCY');
    });

    it('AgyHarnessAdapter decorates domain prompt with green tool permissions and guardrails', () => {
      const agy = new AgyHarnessAdapter();
      const domainPrompt = 'Test domain prompt content';
      const decorated = agy.decorateScoutPrompt(domainPrompt);

      expect(decorated).toContain('CRITICAL OPERATIONAL HARNESS DIRECTIVES:');
      expect(decorated).toContain('search_web');
      expect(decorated).toContain('read_url_content');
      expect(decorated).toContain('DO NOT launch background tasks');
      expect(decorated).toContain(domainPrompt);
    });

    it('GeminiStudioHarnessAdapter leaves domain prompt clean without Antigravity noise', () => {
      const cloud = new GeminiStudioHarnessAdapter();
      const domainPrompt = 'Test domain prompt content';
      const decorated = cloud.decorateScoutPrompt(domainPrompt);

      expect(decorated).toBe(domainPrompt);
      expect(decorated).not.toContain('CRITICAL OPERATIONAL HARNESS DIRECTIVES');
    });

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

    it('builds focused Waypoint Scope prompt with enriched corridor telemetry and stop order', () => {
      const scope: ScoutScope = {
        type: 'waypoint',
        waypointId: 'wp_shiprock',
      };
      const enrichedTripContext: ScoutTripContext = {
        ...sampleTripContext,
        focusedWaypointIndex: 2,
        totalWaypoints: 3,
        precedingWaypoint: { id: 'wp_depart', name: 'Little America Hotel Flagstaff', distanceMiles: 195.2 },
        followingWaypoint: { id: 'wp_arrive', name: 'Vista Del Rio Lodge Chama', distanceMiles: 142.8 },
      };
      const request: ScoutChatRequest = {
        scope,
        messages: [{ role: 'user', content: 'Where along the highway should this be positioned?' }],
        tripContext: enrichedTripContext,
      };

      const prompt = buildScoutPrompt(request);
      expect(prompt).toContain('Route Position: Stop 2 of 3 on today\'s route');
      expect(prompt).toContain('Preceding Stop: "Little America Hotel Flagstaff" (~195.2 mi earlier)');
      expect(prompt).toContain('Following Stop: "Vista Del Rio Lodge Chama" (~142.8 mi ahead)');
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

    it('extracts notification fields from update_waypoint suggestion card', () => {
      const rawModelOutput = `I have audited your Farmington stop. Moving it to the real Maverik station.

\`\`\`json:suggestions
[
  {
    "action": "update_waypoint",
    "targetWaypointId": "wp_farmington",
    "newId": "maverik_farmington",
    "name": "Maverik Adventure's First Stop (Farmington)",
    "type": "fuel",
    "lat": 36.7328,
    "lng": -108.2443,
    "dwell_minutes": 15,
    "trigger_radius_miles": 1.5,
    "reason": "Commercial service station with 16 pumps and clean restrooms.",
    "notification": {
      "title": "Maverik Fuel & Food Stop",
      "message": "2710 W Main St on US-64. Fuel pumps, clean restrooms, and refreshments.",
      "speech": "Approaching Maverik Adventure Stop on West Main Street. Fuel and rest break recommended."
    }
  }
]
\`\`\``;

      const { reply, suggestions } = parseScoutResponse(rawModelOutput);
      expect(reply).toContain('I have audited your Farmington stop');
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].action).toBe('update_waypoint');
      expect(suggestions[0].targetWaypointId).toBe('wp_farmington');
      expect(suggestions[0].newId).toBe('maverik_farmington');
      expect(suggestions[0].notification).toBeDefined();
      expect(suggestions[0].notification?.title).toBe('Maverik Fuel & Food Stop');
      expect(suggestions[0].notification?.speech).toContain('Approaching Maverik Adventure Stop');
    });

    it('separates agent tool preamble from substantive answer', () => {
      const rawWithPreamble = `I have launched a query to inspect the exact road geometry and satellite imagery around exit 294 on I-40. I will analyze the results as soon as they return.

### Meteor Crater Road Exit (Exit 294) - Safety & Access Review

Upon inspecting the coordinates, the current pin is on the Interstate shoulder. I recommend shifting it to the paved rest area.`;

      const { reply, thought } = parseScoutResponse(rawWithPreamble);
      expect(thought).toContain('I have launched a query to inspect');
      expect(thought).toContain('I will analyze the results as soon as they return');
      expect(reply).toContain('### Meteor Crater Road Exit');
      expect(reply).not.toContain('I have launched a query');
    });

    it('parses multiple suggestions when appropriate without error', () => {
      const rawMultiOutput = `Here are two recommendations for your leg: a scenic overlook and a diner stop.

\`\`\`json:suggestions
[
  {
    "action": "add_waypoint",
    "name": "Meteor Crater Overlook",
    "type": "scenic_pull_off",
    "lat": 35.0278,
    "lng": -111.0222,
    "dwell_minutes": 25,
    "reason": "Dramatic crater view right off I-40."
  },
  {
    "action": "add_waypoint",
    "name": "Twin Arrows Diner",
    "type": "meal",
    "lat": 35.1589,
    "lng": -111.2819,
    "dwell_minutes": 40,
    "reason": "Classic Route 66 diner break."
  }
]
\`\`\``;

      const { reply, suggestions } = parseScoutResponse(rawMultiOutput);
      expect(reply).toContain('Here are two recommendations');
      expect(suggestions).toHaveLength(2);
      expect(suggestions[0].name).toBe('Meteor Crater Overlook');
      expect(suggestions[1].name).toBe('Twin Arrows Diner');
    });

    it('strips harness noise like "Wait for the background task to complete" and trailing meta-commentary', () => {
      const dirtyOutput = `Wait for the background task to complete. That makes total sense. Since you will be topped off leaving Flagstaff, skipping a generic commercial fuel stop in central Gallup keeps you out of unnecessary traffic.

My top recommendation is Red Rock Park, situated just about 6 miles east of Gallup.

I have framed this as a candidate update below to convert your focused Gallup fuel waypoint into a 35-minute scenic lunch and restroom stop.`;

      const cleaned = sanitizeScoutReply(dirtyOutput);
      expect(cleaned).not.toContain('Wait for the background task to complete');
      expect(cleaned).not.toContain('I have framed this as a candidate update below');
      expect(cleaned).toContain('That makes total sense.');
      expect(cleaned).toContain('Red Rock Park');
    });

    it('gracefully returns clean prose when no suggestions block is present', () => {
      const rawOutput = 'The timing on this leg looks fantastic! 7:30 AM departure gives you plenty of daylight.';
      const { reply, suggestions } = parseScoutResponse(rawOutput);
      expect(reply).toBe(rawOutput);
      expect(suggestions).toEqual([]);
    });

    it('chat throws friendly error when engine fails rather than returning silent template', async () => {
      const scout = new ScoutService();
      await expect(
        scout.chat(
          {
            scope: { type: 'day', dayNumber: 2 },
            messages: [{ role: 'user', content: 'hello' }],
            tripContext: sampleTripContext,
          },
          { preferredEngine: 'cloud', apiKey: 'invalid-key' }
        )
      ).rejects.toThrow(/Route Scout/);
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

    it('provides multi-stop route audit fallback for day scope detecting off-highway detours and trailer park fuel stop', () => {
      const problematicTripContext: ScoutTripContext = {
        tripName: 'Phoenix to Albuquerque Road Trip',
        origin: 'Flagstaff, AZ',
        destination: 'Chama, NM',
        waypoints: [
          {
            id: 'painted_desert_view',
            name: 'Painted Desert Badlands',
            type: 'scenic_pull_off',
            lat: 34.981,
            lng: -110.0545, // on dirt Goodwater Rd
            dwell_minutes: 0,
          },
          {
            id: 'gallup_fuel',
            name: 'Red Rock Park (Picnic & Stretch)',
            type: 'meal',
            lat: 35.5458,
            lng: -108.6255,
            dwell_minutes: 30,
            notification: {
              title: 'Gallup, NM - Fuel & Stretch',
              message: 'Target 11:30 AM MDT. Turn north on US-491 next.',
              speech: 'Arriving in Gallup, New Mexico. Fuel stop recommended before heading north on US-491.',
            },
          },
          {
            id: 'shiprock_peak',
            name: 'Shiprock Peak (US-491)',
            type: 'scenic_pull_off',
            lat: 36.6872,
            lng: -108.6875, // 1.1 mi into desert scrub
            dwell_minutes: 0,
          },
          {
            id: 'wp_1789354019621_9s3w',
            name: "Maverik Adventure's First Stop (Farmington)",
            type: 'fuel',
            lat: 36.7465,
            lng: -108.2675, // residential trailer park on Finch Ave
            dwell_minutes: 15,
          },
        ],
      };

      const request: ScoutChatRequest = {
        scope: { type: 'day', dayNumber: 2 },
        messages: [{ role: 'user', content: 'Look carefully at some of the drive by waypoints and the fuel stop. They each take me off the highway. Can you audit and fix these?' }],
        tripContext: problematicTripContext,
      };

      const result = generateTemplateScoutResponse(request);
      expect(result.reply).toContain('Route Audit & Highway Alignment Report');
      expect(result.suggestions.length).toBe(4);

      const pdSug = result.suggestions.find((s) => s.targetWaypointId === 'painted_desert_view');
      expect(pdSug).toBeDefined();
      expect(pdSug?.lat).toBe(34.9809);
      expect(pdSug?.lng).toBe(-110.0525);
      expect(pdSug?.dwell_minutes).toBe(0);

      const gallupSug = result.suggestions.find((s) => s.targetWaypointId === 'gallup_fuel');
      expect(gallupSug).toBeDefined();
      expect(gallupSug?.newId).toBe('gallup_red_rock_park');
      expect(gallupSug?.type).toBe('meal');
      expect(gallupSug?.notification?.title).toBe('Red Rock Park Picnic & Stretch');
      expect(gallupSug?.notification?.speech).toContain('picnic');
      expect(gallupSug?.notification?.speech).not.toContain('Fuel stop');

      const srSug = result.suggestions.find((s) => s.targetWaypointId === 'shiprock_peak');
      expect(srSug).toBeDefined();
      expect(srSug?.lat).toBe(36.6878);
      expect(srSug?.lng).toBe(-108.7078);
      expect(srSug?.dwell_minutes).toBe(0);

      const fuelSug = result.suggestions.find((s) => s.targetWaypointId === 'wp_1789354019621_9s3w');
      expect(fuelSug).toBeDefined();
      expect(fuelSug?.newId).toBe('maverik_farmington');
      expect(fuelSug?.lat).toBe(36.7328);
      expect(fuelSug?.lng).toBe(-108.2443);
      expect(fuelSug?.type).toBe('fuel');
      expect(fuelSug?.notification?.title).toContain('Maverik');
    });

    it('provides waypoint copy and ID synchronization fallback when meal stop has fuel ID and speech', () => {
      const gallupWaypoint = {
        id: 'gallup_fuel',
        name: 'Red Rock Park (Picnic & Stretch)',
        type: 'meal',
        lat: 35.5458,
        lng: -108.6255,
        dwell_minutes: 30,
        notification: {
          title: 'Gallup, NM - Fuel & Stretch',
          message: 'Target 11:30 AM MDT. Turn north on US-491 next.',
          speech: 'Arriving in Gallup, New Mexico. Fuel stop recommended before heading north on US-491.',
        },
      };
      const request: ScoutChatRequest = {
        scope: { type: 'waypoint', waypointId: gallupWaypoint.id, waypointName: gallupWaypoint.name },
        messages: [{ role: 'user', content: 'Why does the alert and voice say fuel stop when this is a picnic lunch stop at a park?' }],
        tripContext: {
          tripName: 'Test Trip',
          waypoints: [gallupWaypoint],
          focusedWaypoint: gallupWaypoint,
        },
      };

      const result = generateTemplateScoutResponse(request);
      expect(result.reply).toContain('Waypoint Copy & ID Synchronization');
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].action).toBe('update_waypoint');
      expect(result.suggestions[0].targetWaypointId).toBe('gallup_fuel');
      expect(result.suggestions[0].newId).toBe('gallup_red_rock_park');
      expect(result.suggestions[0].type).toBe('meal');
      expect(result.suggestions[0].notification?.title).toBe('Red Rock Park Picnic & Stretch');
      expect(result.suggestions[0].notification?.speech).toContain('picnic');
      expect(result.suggestions[0].notification?.speech).not.toContain('Fuel stop');
    });

    it('provides fuel stop audit fallback for waypoint scope relocating trailer park pin to commercial Maverik', () => {
      const fuelWaypoint = {
        id: 'wp_1789354019621_9s3w',
        name: "Maverik Adventure's First Stop (Farmington)",
        type: 'fuel',
        lat: 36.7465,
        lng: -108.2675,
        dwell_minutes: 15,
      };
      const request: ScoutChatRequest = {
        scope: { type: 'waypoint', waypointId: fuelWaypoint.id, waypointName: fuelWaypoint.name },
        messages: [{ role: 'user', content: 'This fuel stop is in a residential trailer park. Where is the real gas station?' }],
        tripContext: {
          tripName: 'Test Trip',
          waypoints: [fuelWaypoint],
          focusedWaypoint: fuelWaypoint,
        },
      };

      const result = generateTemplateScoutResponse(request);
      expect(result.reply).toContain('Commercial Fuel Stop Audit');
      expect(result.reply).toContain('2710 W Main St');
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].action).toBe('update_waypoint');
      expect(result.suggestions[0].lat).toBe(36.7328);
      expect(result.suggestions[0].lng).toBe(-108.2443);
      expect(result.suggestions[0].notification?.title).toBe('Maverik Fuel & Food Stop');
    });

    it('provides scenic trigger repositioning fallback when driver asks if drive-by should be farther west', () => {
      const dulceWaypoint = {
        id: 'dulce_foothills',
        name: 'Jicarilla Apache Nation / Dulce',
        type: 'scenic_drive_by',
        lat: 36.9335,
        lng: -106.9919,
        dwell_minutes: 0,
        notification: {
          title: 'Climbing into Pine Country',
          message: 'Target 3:30 PM. Watch for autumn foliage.',
          speech: 'Climbing through the Jicarilla Apache Nation on US-64. Watch for early autumn aspen color as we enter the foothills.',
        },
      };
      const request: ScoutChatRequest = {
        scope: { type: 'waypoint', waypointId: dulceWaypoint.id, waypointName: dulceWaypoint.name },
        messages: [{ role: 'user', content: "Is this accurate? It's pretty close to my final destination for the day and it looks most of scenery will have already passed by this point. Perhaps this should be a little farther west?" }],
        tripContext: {
          tripName: 'Test Trip',
          waypoints: [dulceWaypoint],
          focusedWaypoint: dulceWaypoint,
        },
      };

      const result = generateTemplateScoutResponse(request);
      expect(result.reply).toContain('Scenic Trigger Repositioning');
      expect(result.reply).toContain('~28 miles west');
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].action).toBe('update_waypoint');
      expect(result.suggestions[0].name).toBe('Climbing into Pine Country (US-64)');
      expect(result.suggestions[0].type).toBe('scenic_drive_by');
      expect(result.suggestions[0].lat).toBe(36.7625);
      expect(result.suggestions[0].lng).toBe(-107.2018);
      expect(result.suggestions[0].dwell_minutes).toBe(0);
      expect(result.suggestions[0].notification?.title).toBe('Climbing into Pine Country');
      expect(result.suggestions[0].notification?.speech).toContain('Carson National Forest');
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

    it('POST /api/ai/scout/chat/stream streams SSE events with delta and done', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat/stream',
        payload: {
          scope: { type: 'day', dayNumber: 2 },
          messages: [{ role: 'user', content: 'Where can we stop for lunch?' }],
          tripContext: sampleTripContext,
          preferredEngine: 'template',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      const body = response.body;
      expect(body).toContain('event: delta');
      expect(body).toContain('event: done');
      expect(body).toContain('Mid-Route Dining Recommendations');
    });
  });
});
