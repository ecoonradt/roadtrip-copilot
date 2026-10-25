import { describe, it, expect } from 'vitest';
import {
  buildScoutDomainPrompt,
  buildScoutPrompt,
  parseScoutResponse,
  getQuickPrompts,
  ScoutService,
  validateScoutPlaceId,
  isValidGooglePlaceId,
} from '../../server/services/scoutService.js';
import { AiService, type AiHarnessAdapter } from '../../server/services/aiService.js';
import { AwsBedrockHarnessAdapter, sanitizeBedrockResponse } from '../../server/services/bedrockService.js';
import { MalformedAiResponseError } from '../../server/services/schemaParser.js';
import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { vi } from 'vitest';
import { createApp } from '../../server/app.js';
import type { ToolDeclaration, GenerateStreamWithToolsResult, AiModelOption } from '../../server/types/ai.js';
import type { ScoutChatRequest, ScoutScope, ScoutTripContext, ScoutStreamEvent } from '../../server/types/scout.js';

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
      expect(domainPrompt).toContain('OPERATIONAL "ONE ANCHOR PER CORRIDOR" RULE');
      expect(domainPrompt).toContain('DIVERGENT SCENIC BYWAY');
      expect(domainPrompt).toContain('AUDIO COMMENTARY ONLY');
      expect(domainPrompt).toContain('DIVIDED HIGHWAY HAZARDS');
      expect(domainPrompt).toContain('AUTHENTIC ENTRANCES FOR PHYSICAL STOPS');
      expect(domainPrompt).toContain('Address: "AZ-179 at Bell Rock Blvd, Sedona, AZ"');
      expect(domainPrompt).toContain('PlaceID: "ChIJ_sedona"');
      expect(domainPrompt).toContain('[Route Anchor]');
    });

    it('AwsBedrockHarnessAdapter leaves domain prompt clean without Antigravity noise', () => {
      const bedrock = new AwsBedrockHarnessAdapter({ available: false });
      const domainPrompt = 'Test domain prompt content';
      const decorated = bedrock.decorateScoutPrompt(domainPrompt);

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
    "place_name": "Cameron Trading Post",
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
      expect(suggestions[0].place_name).toBe('Cameron Trading Post');
      expect(suggestions[0].type).toBe('meal');
      expect(suggestions[0].lat).toBe(35.8756);
      expect(suggestions[0].lng).toBe(-111.4128);
      expect(suggestions[0].dwell_minutes).toBe(45);
    });

    it('parses add_waypoint suggestion with type: "stop" for grocery and errand stops', () => {
      const rawModelOutput = `I recommend a quick supply stop at Safeway in Sedona before continuing into Oak Creek Canyon.

\`\`\`json:suggestions
[
  {
    "action": "add_waypoint",
    "name": "Safeway Sedona Grocery Stop",
    "place_name": "Safeway",
    "type": "stop",
    "lat": 34.8697,
    "lng": -111.7609,
    "dwell_minutes": 25,
    "trigger_radius_miles": 0.5,
    "address": "2300 W State Rte 89A, Sedona, AZ 86336",
    "is_route_anchor": true,
    "reason": "Restock snacks, drinks, and ice before remote scenic driving."
  }
]
\`\`\``;

      const { reply, suggestions } = parseScoutResponse(rawModelOutput);
      expect(reply).toContain('quick supply stop at Safeway');
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].action).toBe('add_waypoint');
      expect(suggestions[0].name).toBe('Safeway Sedona Grocery Stop');
      expect(suggestions[0].place_name).toBe('Safeway');
      expect(suggestions[0].type).toBe('stop');
      expect(suggestions[0].lat).toBe(34.8697);
      expect(suggestions[0].lng).toBe(-111.7609);
      expect(suggestions[0].dwell_minutes).toBe(25);
      expect(suggestions[0].address).toBe('2300 W State Rte 89A, Sedona, AZ 86336');
      // Must enforce is_route_anchor = false because stop is a physical stop
      expect(suggestions[0].is_route_anchor).toBe(false);
      // Must suppress notification because generic stops are silent
      expect(suggestions[0].notification).toBeUndefined();
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

    it('deterministically strips hallucinated or unverified Google Place IDs unless present in knownPlaceIds on physical stops, and always strips them on scenic anchors', () => {
      const rawPhysicalOutput = `Audited stop.
\`\`\`json:suggestions
[
  {
    "action": "update_waypoint",
    "targetWaypointId": "wp_sedona",
    "name": "Sedona Red Rocks Cafe",
    "type": "meal",
    "lat": 34.7865,
    "lng": -111.7612,
    "dwell_minutes": 45,
    "google_place_id": "ChIJfake_hallucinated_place_id_12345"
  }
]
\`\`\``;

      // With an empty knownPlaceIds set (no verified place IDs on the route yet), the newly invented ID is stripped
      const { suggestions: stripped } = parseScoutResponse(rawPhysicalOutput, {
        knownPlaceIds: new Set(['ChIJverified_other_id_1234567890']),
      });
      expect(stripped[0].google_place_id).toBeUndefined();
      expect(stripped[0].is_route_anchor).toBe(false);

      // When the ID is in knownPlaceIds on a physical stop, it is retained
      const { suggestions: retained } = parseScoutResponse(rawPhysicalOutput, {
        knownPlaceIds: new Set(['ChIJfake_hallucinated_place_id_12345']),
      });
      expect(retained[0].google_place_id).toBe('ChIJfake_hallucinated_place_id_12345');

      // On a scenic drive-by / route anchor, google_place_id is always stripped even if present in knownPlaceIds
      const rawScenicOutput = `Audited scenic anchor.
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
      const { suggestions: scenicAnchor } = parseScoutResponse(rawScenicOutput, {
        knownPlaceIds: new Set(['ChIJfake_hallucinated_place_id_12345']),
      });
      expect(scenicAnchor[0].google_place_id).toBeUndefined();
      expect(scenicAnchor[0].is_route_anchor).toBe(true);
    });

    it('validates Google Place ID formatting with validateScoutPlaceId and isValidGooglePlaceId', () => {
      // Real verified Place IDs from Google Places protobuf format
      expect(isValidGooglePlaceId('ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q')).toBe(true);
      expect(isValidGooglePlaceId('ChIJCR3fWhuQO4cRxCLXXbAfCxQ')).toBe(true);
      expect(isValidGooglePlaceId('ChIJ2wW_a80KK4cR24D7xO_z5Y4')).toBe(true);

      // Hallucinated or fake IDs fail binary protobuf verification
      expect(isValidGooglePlaceId('ChIJfake_hallucinated_place_id_12345')).toBe(false);
      expect(isValidGooglePlaceId('ChIJshort')).toBe(false);
      expect(isValidGooglePlaceId('invalid_prefix_12345')).toBe(false);

      // validateScoutPlaceId accepts real Place IDs
      expect(validateScoutPlaceId('ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q')).toBe('ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q');
      expect(validateScoutPlaceId('ChIJCR3fWhuQO4cRxCLXXbAfCxQ')).toBe('ChIJCR3fWhuQO4cRxCLXXbAfCxQ');

      // Invalid or hallucinated strings are rejected
      expect(validateScoutPlaceId('invalid_place_id_12345')).toBeUndefined();
      expect(validateScoutPlaceId('ChIJshort')).toBeUndefined();
      expect(validateScoutPlaceId('ChIJfake_hallucinated_place_id_12345')).toBeUndefined();
      expect(validateScoutPlaceId(null)).toBeUndefined();
      expect(validateScoutPlaceId(12345)).toBeUndefined();
      expect(validateScoutPlaceId('')).toBeUndefined();

      // Whitelist check: If present in knownPlaceIds, it is trusted even if it were a legacy mock
      const whitelist = new Set(['ChIJvalid_and_known_123456789']);
      expect(validateScoutPlaceId('ChIJvalid_and_known_123456789', whitelist)).toBe('ChIJvalid_and_known_123456789');
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

      const cleaned = sanitizeBedrockResponse(dirtyOutput);
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

    it('throws MalformedAiResponseError when json:suggestions block is incomplete or truncated', () => {
      const truncatedOutput = `I recommend this stop:\n\n\`\`\`json:suggestions\n[\n  {"action": "add_waypoint", "name": "Broken Stop"`;
      expect(() => parseScoutResponse(truncatedOutput)).toThrow(MalformedAiResponseError);
      expect(() => parseScoutResponse(truncatedOutput)).toThrow(/incomplete or truncated suggestions block/);
    });

    it('throws MalformedAiResponseError when json:suggestions contains invalid JSON', () => {
      const invalidJsonOutput = `Here are suggestions:\n\n\`\`\`json:suggestions\n[{"action": "add_waypoint", invalid json}\n\`\`\``;
      expect(() => parseScoutResponse(invalidJsonOutput)).toThrow(MalformedAiResponseError);
      expect(() => parseScoutResponse(invalidJsonOutput)).toThrow(/unparseable suggestions block/);
    });

    it('throws MalformedAiResponseError when json:suggestions block is empty', () => {
      const emptyJsonOutput = `Here are suggestions:\n\n\`\`\`json:suggestions\n   \n\`\`\``;
      expect(() => parseScoutResponse(emptyJsonOutput)).toThrow(MalformedAiResponseError);
      expect(() => parseScoutResponse(emptyJsonOutput)).toThrow(/empty suggestions block/);
    });

    it('chat throws loud error when engine fails rather than returning silent template', async () => {
      const mockModels: AiModelOption[] = [
        {
          id: 'us.moonshotai.kimi-k3',
          name: 'Moonshot Kimi K3',
          provider: 'Moonshot AI',
          description: 'Flagship 2.8T MoE corridor & agentic reasoning engine (1M context)',
          role: 'both',
        },
      ];
      const mockBedrock = new AwsBedrockHarnessAdapter({
        availableModels: mockModels,
        client: {
          send: vi.fn().mockRejectedValue(new Error('Bedrock connection timeout')),
        } as unknown as BedrockRuntimeClient,
      });
      const aiService = new AiService({ adapters: [mockBedrock] });
      const scout = new ScoutService(aiService);
      await expect(
        scout.chat(
          {
            scope: { type: 'day', dayNumber: 2 },
            messages: [{ role: 'user', content: 'hello' }],
            tripContext: sampleTripContext,
          },
          { preferredEngine: 'bedrock' }
        )
      ).rejects.toThrow(/Bedrock connection timeout/);
    });
  });

  describe('Quick Prompts', () => {
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
    function createScoutApp() {
      const adapter: AiHarnessAdapter = {
        id: 'bedrock',
        name: 'Test Provider',
        isAvailable: async () => true,
        generate: async () => 'Day 2 looks well paced. Consider a lunch stop in Gallup.',
        validateModelId: (modelId: string) => modelId,
        getAvailableModels: async () => [],
        getModelCatalog: () => ({
          models: [],
          defaultScoutModelId: 'test-scout-model',
          defaultCopywriterModelId: 'test-copywriter-model',
        }),
        decorateScoutPrompt: (prompt: string) => prompt,
        sanitizeResponse: (text: string) => text,
        generateStreamWithTools: async (
          _prompt: string,
          _tools: ToolDeclaration[],
          _dispatcher: (name: string, args: Record<string, unknown>) => Promise<unknown>,
          onChunk: (event: ScoutStreamEvent) => void
        ): Promise<GenerateStreamWithToolsResult> => {
          const text = 'Day 2 looks well paced. Consider a lunch stop in Gallup.';
          onChunk({ event: 'delta', data: { text } });
          return { text, inputTokens: 10, outputTokens: 5 };
        },
      };
      const scoutService = new ScoutService(new AiService({ adapters: [adapter] }));
      return createApp({ logger: false, scoutService });
    }

    const app = createScoutApp();

    it('POST /api/ai/scout/chat returns 200 with reply and suggestions', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat',
        payload: {
          scope: { type: 'day', dayNumber: 2 },
          messages: [{ role: 'user', content: 'Where should we eat lunch?' }],
          tripContext: sampleTripContext,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data).toHaveProperty('reply');
      expect(data).toHaveProperty('suggestions');
      expect(data).toHaveProperty('sessionId');
      expect(data.engine).toBe('bedrock');
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

    it('POST /api/ai/scout/chat rejects an unregistered engine with 400', async () => {
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

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('not registered');
    });

    it('POST /api/ai/scout/chat returns 502 when the provider returns an empty reply', async () => {
      const emptyAdapter: AiHarnessAdapter = {
        id: 'bedrock',
        name: 'Test Provider',
        isAvailable: async () => true,
        generate: async () => '   ',
        validateModelId: (modelId: string) => modelId,
        getAvailableModels: async () => [],
        getModelCatalog: () => ({
          models: [],
          defaultScoutModelId: 'test-scout-model',
          defaultCopywriterModelId: 'test-copywriter-model',
        }),
        decorateScoutPrompt: (prompt: string) => prompt,
        sanitizeResponse: (text: string) => text,
      };
      const emptyApp = createApp({
        logger: false,
        scoutService: new ScoutService(new AiService({ adapters: [emptyAdapter] })),
      });

      const response = await emptyApp.inject({
        method: 'POST',
        url: '/api/ai/scout/chat',
        payload: {
          scope: { type: 'day', dayNumber: 2 },
          messages: [{ role: 'user', content: 'Where should we eat lunch?' }],
          tripContext: sampleTripContext,
        },
      });

      expect(response.statusCode).toBe(502);
      expect(response.json().error).toContain('empty Route Scout response');
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
        },
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.reply).toBeTruthy();
      expect(data.engine).toBe('bedrock');
    });

    it('POST /api/ai/scout/chat/stream streams SSE events with delta and done', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat/stream',
        payload: {
          scope: { type: 'day', dayNumber: 2 },
          messages: [{ role: 'user', content: 'Where can we stop for lunch?' }],
          tripContext: sampleTripContext,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      const body = response.body;
      expect(body).toContain('event: delta');
      expect(body).toContain('event: done');
      expect(body).toContain('lunch stop in Gallup');
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

    it('POST /api/ai/scout/chat/stream returns 400 synchronously for unregistered provider without modelId', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat/stream',
        payload: {
          scope: { type: 'day', dayNumber: 2 },
          messages: [{ role: 'user', content: 'Where can we stop?' }],
          tripContext: sampleTripContext,
          preferredEngine: 'unregistered-provider',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain('application/json');
      const data = response.json();
      expect(data.error).toContain('AI provider "unregistered-provider" is not registered');
    });

    it('non-streaming provider seam passes resolved activeModelId to generate() when modelId is omitted', async () => {
      const generateSpy = vi.fn().mockResolvedValue('Non-streaming reply from mock adapter');
      const nonStreamingAdapter: AiHarnessAdapter = {
        id: 'mock-non-streaming',
        name: 'Mock Non-Streaming Adapter',
        isAvailable: async () => true,
        generate: generateSpy,
        validateModelId: (m: string) => m,
        getAvailableModels: async () => [],
        getModelCatalog: () => ({
          models: [],
          defaultScoutModelId: 'custom-scout-model-id',
          defaultCopywriterModelId: 'custom-copy-model-id',
        }),
        decorateScoutPrompt: (p: string) => p,
        sanitizeResponse: (t: string) => t,
      };

      const testScoutService = new ScoutService(new AiService({ adapters: [nonStreamingAdapter] }));
      const testApp = createApp({ logger: false, scoutService: testScoutService });

      const response = await testApp.inject({
        method: 'POST',
        url: '/api/ai/scout/chat',
        payload: {
          scope: { type: 'day', dayNumber: 2 },
          messages: [{ role: 'user', content: 'Tell me about the route' }],
          tripContext: sampleTripContext,
          preferredEngine: 'mock-non-streaming',
        },
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.modelId).toBe('custom-scout-model-id');
      expect(generateSpy).toHaveBeenCalledTimes(1);
      expect(generateSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ modelId: 'custom-scout-model-id' })
      );
    });
  });
});
