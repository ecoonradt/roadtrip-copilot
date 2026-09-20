import { describe, it, expect } from 'vitest';
import {
  buildScoutDomainPrompt,
  buildScoutPrompt,
  parseScoutResponse,
  generateTemplateScoutResponse,
  getQuickPrompts,
  ScoutService,
  sanitizeScoutReply,
  validateScoutPlaceId,
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

    it('domain prompt includes Google Maps navigation auditing and route anchor guidelines', () => {
      const scope: ScoutScope = { type: 'day', dayNumber: 1 };
      const request: ScoutChatRequest = {
        scope,
        messages: [{ role: 'user', content: 'Audit my route waypoints for Google Maps' }],
        tripContext: {
          ...sampleTripContext,
          waypoints: [
            {
              id: 'wp_sedona',
              name: 'Sedona Red Rocks Vista',
              type: 'scenic_drive_by',
              lat: 34.775,
              lng: -111.7635,
              address: 'AZ-179 at Bell Rock Blvd, Sedona, AZ',
              google_place_id: 'ChIJ_sedona',
              is_route_anchor: true,
            },
          ],
        },
      };

      const domainPrompt = buildScoutDomainPrompt(request);
      expect(domainPrompt).toContain('GOOGLE MAPS NAVIGATION AUDITING & ROUTE ANCHORS');
      expect(domainPrompt).toContain('DIVIDED HIGHWAY HAZARDS');
      expect(domainPrompt).toContain('AUTHENTIC ENTRANCES FOR PHYSICAL STOPS');
      expect(domainPrompt).toContain('Address: "AZ-179 at Bell Rock Blvd, Sedona, AZ"');
      expect(domainPrompt).toContain('PlaceID: "ChIJ_sedona"');
      expect(domainPrompt).toContain('[Route Anchor]');
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

    it('extracts address, google_place_id, and is_route_anchor from suggestion card', () => {
      const rawModelOutput = `I have audited your Flagstaff hotel stop and added the official Place ID and address.

\`\`\`json:suggestions
[
  {
    "action": "update_waypoint",
    "targetWaypointId": "flagstaff_little_america",
    "name": "Little America Hotel Flagstaff",
    "type": "lodging",
    "lat": 35.1901,
    "lng": -111.6207,
    "dwell_minutes": 0,
    "trigger_radius_miles": 2.0,
    "address": "2515 E Butler Ave, Flagstaff, AZ 86004",
    "google_place_id": "ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q",
    "is_route_anchor": false,
    "reason": "Authentic hotel lobby address and verified Google Place ID.",
    "notification": {
      "title": "Little America Check-in",
      "message": "Turn into main lodge driveway off Butler Ave.",
      "speech": "Arriving at Little America Hotel on Butler Avenue."
    }
  }
]
\`\`\``;

      const { reply, suggestions } = parseScoutResponse(rawModelOutput);
      expect(reply).toContain('I have audited your Flagstaff hotel stop');
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].address).toBe('2515 E Butler Ave, Flagstaff, AZ 86004');
      expect(suggestions[0].google_place_id).toBe('ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q');
      expect(suggestions[0].is_route_anchor).toBe(false);
    });

    it('deterministically strips hallucinated or unverified Google Place IDs unless present in knownPlaceIds', () => {
      const rawModelOutput = `Audited stop.
\`\`\`json:suggestions
[
  {
    "action": "update_waypoint",
    "targetWaypointId": "wp_sedona",
    "name": "Sedona Red Rocks Vista",
    "type": "scenic_drive_by",
    "lat": 34.7865,
    "lng": -111.7612,
    "dwell_minutes": 0,
    "google_place_id": "ChIJfake_hallucinated_place_id_12345",
    "is_route_anchor": true
  }
]
\`\`\``;

      // With an empty knownPlaceIds set (no verified place IDs on the route yet), the newly invented ID is stripped
      const { suggestions: stripped } = parseScoutResponse(rawModelOutput, {
        knownPlaceIds: new Set(['ChIJverified_other_id_1234567890']),
      });
      expect(stripped[0].google_place_id).toBeUndefined();
      expect(stripped[0].is_route_anchor).toBe(true);

      // When the ID is in knownPlaceIds, it is retained
      const { suggestions: retained } = parseScoutResponse(rawModelOutput, {
        knownPlaceIds: new Set(['ChIJfake_hallucinated_place_id_12345']),
      });
      expect(retained[0].google_place_id).toBe('ChIJfake_hallucinated_place_id_12345');
    });

    it('validates Google Place ID formatting with validateScoutPlaceId', () => {
      expect(validateScoutPlaceId('ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q')).toBe('ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q');
      // Must start with ChIJ
      expect(validateScoutPlaceId('invalid_place_id_12345')).toBeUndefined();
      // Too short
      expect(validateScoutPlaceId('ChIJshort')).toBeUndefined();
      // Non-string
      expect(validateScoutPlaceId(null)).toBeUndefined();
      expect(validateScoutPlaceId(12345)).toBeUndefined();
      expect(validateScoutPlaceId('')).toBeUndefined();

      // Whitelist check
      const whitelist = new Set(['ChIJvalid_and_known_123456789']);
      expect(validateScoutPlaceId('ChIJvalid_and_known_123456789', whitelist)).toBe('ChIJvalid_and_known_123456789');
      expect(validateScoutPlaceId('ChIJvalid_but_unknown_12345678', whitelist)).toBeUndefined();
    });

    it('strictly forces is_route_anchor = false on physical stops even if AI flags them as anchors', () => {
      const rawModelOutput = `I recommend adding a dinner stop with route anchor.
\`\`\`json:suggestions
[
  {
    "action": "add_waypoint",
    "name": "Sedona Grill",
    "type": "meal",
    "lat": 34.8697,
    "lng": -111.7609,
    "dwell_minutes": 45,
    "is_route_anchor": true
  },
  {
    "action": "add_waypoint",
    "name": "Oak Creek Highway Anchor",
    "type": "scenic_drive_by",
    "lat": 34.9876,
    "lng": -111.7543,
    "dwell_minutes": 0,
    "is_route_anchor": true
  }
]
\`\`\``;

      const { suggestions } = parseScoutResponse(rawModelOutput);
      expect(suggestions).toHaveLength(2);
      // Meal stop with 45m dwell: must NOT be an anchor
      expect(suggestions[0].is_route_anchor).toBe(false);
      // Scenic drive-by with 0m dwell: allowed to be an anchor
      expect(suggestions[1].is_route_anchor).toBe(true);
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

    it('provides multi-stop route audit fallback for day scope detecting missing addresses, copy mismatches, and drive-by dwell', () => {
      const problematicTripContext: ScoutTripContext = {
        tripName: 'Summer Road Trip',
        origin: 'Origin City',
        destination: 'Destination City',
        waypoints: [
          {
            id: 'scenic_overlook_driveby',
            name: 'Scenic Mountain Overlook',
            type: 'scenic_drive_by',
            lat: 34.981,
            lng: -110.0545,
            dwell_minutes: 15, // error: drive-by should have 0 dwell
          },
          {
            id: 'park_fuel',
            name: 'State Park Picnic Area',
            type: 'meal',
            lat: 35.5458,
            lng: -108.6255,
            dwell_minutes: 30,
            address: '100 State Park Rd',
            notification: {
              title: 'Park Fuel Stop',
              message: 'Target 11:30 AM. Fuel stop.',
              speech: 'Arriving at Park. Fuel stop recommended.',
            },
          },
          {
            id: 'lodge_arrival',
            name: 'Valley Mountain Lodge',
            type: 'lodging',
            lat: 36.8748,
            lng: -106.5835,
            dwell_minutes: 0,
            // error: physical stop without address or google_place_id
          },
        ],
      };

      const request: ScoutChatRequest = {
        scope: { type: 'day', dayNumber: 1 },
        messages: [{ role: 'user', content: 'Audit route for Google Maps navigation, detours & stop accuracy' }],
        tripContext: problematicTripContext,
      };

      const result = generateTemplateScoutResponse(request);
      expect(result.reply).toContain('Route Audit & Navigation Report');
      expect(result.suggestions.length).toBe(3);

      const dwellSug = result.suggestions.find((s) => s.targetWaypointId === 'scenic_overlook_driveby');
      expect(dwellSug).toBeDefined();
      expect(dwellSug?.dwell_minutes).toBe(0);

      const syncSug = result.suggestions.find((s) => s.targetWaypointId === 'park_fuel');
      expect(syncSug).toBeDefined();
      expect(syncSug?.newId).toBe('park_meal');
      expect(syncSug?.type).toBe('meal');
      expect(syncSug?.notification?.speech).not.toContain('Fuel stop');

      const navSug = result.suggestions.find((s) => s.targetWaypointId === 'lodge_arrival');
      expect(navSug).toBeDefined();
      expect(navSug?.address).toBe('Valley Mountain Lodge');
    });

    it('provides waypoint copy and ID synchronization fallback when meal stop has fuel ID and speech', () => {
      const mealWaypoint = {
        id: 'picnic_fuel',
        name: 'Valley Park (Picnic & Stretch)',
        type: 'meal',
        lat: 35.5458,
        lng: -108.6255,
        dwell_minutes: 30,
        notification: {
          title: 'Valley Park - Fuel & Stretch',
          message: 'Target 11:30 AM. Turn north next.',
          speech: 'Arriving in Valley Park. Fuel stop recommended before heading north.',
        },
      };
      const request: ScoutChatRequest = {
        scope: { type: 'waypoint', waypointId: mealWaypoint.id, waypointName: mealWaypoint.name },
        messages: [{ role: 'user', content: 'Why does the alert and voice say fuel stop when this is a picnic lunch stop at a park?' }],
        tripContext: {
          tripName: 'Test Trip',
          waypoints: [mealWaypoint],
          focusedWaypoint: mealWaypoint,
        },
      };

      const result = generateTemplateScoutResponse(request);
      expect(result.reply).toContain('Waypoint Copy & ID Synchronization');
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].action).toBe('update_waypoint');
      expect(result.suggestions[0].targetWaypointId).toBe('picnic_fuel');
      expect(result.suggestions[0].newId).toBe('picnic_meal');
      expect(result.suggestions[0].type).toBe('meal');
      expect(result.suggestions[0].notification?.title).toBe('Valley Park (Picnic & Stretch)');
      expect(result.suggestions[0].notification?.speech).not.toContain('Fuel stop');
    });

    it('provides Google Maps navigation audit fallback for waypoint scope missing street address', () => {
      const lodgingWaypoint = {
        id: 'hotel_downtown',
        name: 'Historic Grand Hotel',
        type: 'lodging',
        lat: 35.1901,
        lng: -111.6207,
        dwell_minutes: 0,
      };
      const request: ScoutChatRequest = {
        scope: { type: 'waypoint', waypointId: lodgingWaypoint.id, waypointName: lodgingWaypoint.name },
        messages: [{ role: 'user', content: 'Check Google Maps navigation & address for Historic Grand Hotel' }],
        tripContext: {
          tripName: 'Test Trip',
          waypoints: [lodgingWaypoint],
          focusedWaypoint: lodgingWaypoint,
        },
      };

      const result = generateTemplateScoutResponse(request);
      expect(result.reply).toContain('Google Maps Navigation Audit');
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].action).toBe('update_waypoint');
      expect(result.suggestions[0].address).toBe('Historic Grand Hotel, Main Entrance');
    });

    it('provides in-transit drive-by dwell correction fallback for waypoint scope', () => {
      const driveByWaypoint = {
        id: 'mountain_pass',
        name: 'High Mountain Pass',
        type: 'scenic_drive_by',
        lat: 36.9335,
        lng: -106.9919,
        dwell_minutes: 20, // non-zero dwell on drive-by
        notification: {
          title: 'High Mountain Pass',
          message: 'Approaching the summit.',
          speech: 'Approaching the mountain pass summit on the highway.',
        },
      };
      const request: ScoutChatRequest = {
        scope: { type: 'waypoint', waypointId: driveByWaypoint.id, waypointName: driveByWaypoint.name },
        messages: [{ role: 'user', content: 'Is our planned dwell time appropriate for High Mountain Pass?' }],
        tripContext: {
          tripName: 'Test Trip',
          waypoints: [driveByWaypoint],
          focusedWaypoint: driveByWaypoint,
        },
      };

      const result = generateTemplateScoutResponse(request);
      expect(result.reply).toContain('In-Transit Drive-By Configuration');
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0].action).toBe('update_waypoint');
      expect(result.suggestions[0].type).toBe('scenic_drive_by');
      expect(result.suggestions[0].dwell_minutes).toBe(0);
    });

    it('returns quick prompts appropriate to the scope', () => {
      const dayPrompts = getQuickPrompts({ type: 'day', dayNumber: 1 });
      expect(dayPrompts).toHaveLength(5);
      expect(dayPrompts[0]).toContain('lunch');
      expect(dayPrompts).toContain('Audit route for Google Maps navigation, detours & stop accuracy');

      const wpPrompts = getQuickPrompts({ type: 'waypoint', waypointId: 'wp_1', waypointName: 'Grand Hotel' });
      expect(wpPrompts.length).toBeGreaterThan(2);
      expect(wpPrompts[0]).toBe('Check Google Maps navigation & address for Grand Hotel');
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

    it('POST /api/ai/scout/chat/stream returns 400 for missing scope or messages', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat/stream',
        payload: {
          scope: null,
          messages: [],
        },
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.body);
      expect(data.error).toContain('Invalid request payload');
    });
  });
});
