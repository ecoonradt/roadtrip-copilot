import type {
  ScoutScope,
  ScoutSuggestion,
  ScoutChatRequest,
  ScoutChatResponse,
  ScoutStreamEvent,
  ScoutActivity,
  ScoutWaypointSummary,
} from '../types/scout.js';
import type { ToolDeclaration } from '../types/ai.js';
import type { GenerationOptions, AiHarnessAdapter } from './aiService.js';
import { AiService } from './aiService.js';
import { createDefaultAiService } from './aiRegistry.js';
import { MalformedAiResponseError } from './schemaParser.js';
import { isValidGooglePlaceId, validateScoutPlaceId } from './placeId.js';
import {
  SCOUT_TOOL_DECLARATIONS,
  ScoutToolLibrary,
  createTurnGroundingCache,
  cleanPlaceName,
  haversineMiles,
  type ResolvedPlaceRecord,
  type ScoutToolLibraryOptions,
  type TurnGroundingCache,
} from './scoutTools.js';

export { isValidGooglePlaceId, validateScoutPlaceId };

/**
 * Builds the comprehensive domain prompt for Route Scout (pure road-trip domain, harness-agnostic).
 */
export function buildScoutDomainPrompt(
  request: ScoutChatRequest,
  sanitize: (value: string) => string = (value) => value
): string {
  const { scope, messages, tripContext } = request;

  let contextBlock = `TRIP LEVEL CONTEXT:\n- Trip Name: ${tripContext.tripName}\n`;
  if (tripContext.date) contextBlock += `- Planned Date: ${tripContext.date}\n`;
  if (tripContext.origin) contextBlock += `- Trip Origin: ${tripContext.origin}\n`;
  if (tripContext.destination) contextBlock += `- Trip Destination: ${tripContext.destination}\n`;
  if (tripContext.departureTime) contextBlock += `- Departure Time: ${tripContext.departureTime}\n`;
  if (tripContext.corridor) contextBlock += `- Corridor / Route Description: ${tripContext.corridor}\n`;

  if (scope.type === 'day') {
    contextBlock += `\nACTIVE SCOPE: Day ${scope.dayNumber ?? 1}${scope.dayTitle ? ` (${scope.dayTitle})` : ''}\n`;
    contextBlock += `CURRENT STOPS ON THIS DAY (${tripContext.waypoints.length} total):\n`;
    if (tripContext.waypoints.length === 0) {
      contextBlock += `  (No waypoints added yet for this day. Only start and destination are defined.)\n`;
    } else {
      tripContext.waypoints.forEach((wp, idx) => {
        contextBlock += `  ${idx + 1}. [${wp.id}] "${wp.name}" (${wp.type}) @ ${wp.lat.toFixed(4)}, ${wp.lng.toFixed(4)}`;
        if (wp.target_time) contextBlock += ` | Target: ${wp.target_time}`;
        if (wp.dwell_minutes) contextBlock += ` | Dwell: ${wp.dwell_minutes}m`;
        if (idx > 0 && wp.drive_duration_minutes !== undefined && wp.drive_distance_miles !== undefined) {
          const mph = wp.drive_speed_mph ? ` @ ${wp.drive_speed_mph} mph` : '';
          contextBlock += ` | Leg Drive: ${wp.drive_duration_minutes}m, ${wp.drive_distance_miles} mi${mph}`;
        }
        if (wp.timezone) contextBlock += ` | TZ: ${wp.timezone}`;
        if (wp.notes) contextBlock += ` | Notes: "${wp.notes}"`;
        if (wp.place_name) contextBlock += ` | PlaceName: "${wp.place_name}"`;
        if (wp.address) contextBlock += ` | Address: "${wp.address}"`;
        if (wp.google_place_id) contextBlock += ` | PlaceID: "${wp.google_place_id}"`;
        if (wp.is_route_anchor) contextBlock += ` | [Route Anchor]`;
        if (wp.notification) {
          contextBlock += ` | Alert: "${wp.notification.title}" / Voice: "${wp.notification.speech}"`;
        }
        contextBlock += `\n`;
      });
    }
  } else {
    const focused = tripContext.focusedWaypoint || tripContext.waypoints.find((w) => w.id === scope.waypointId);
    contextBlock += `\nACTIVE SCOPE: Waypoint Audit & Refinement\n`;
    if (focused) {
      contextBlock += `FOCUSED WAYPOINT DETAILS:\n`;
      if (tripContext.focusedWaypointIndex && tripContext.totalWaypoints) {
        contextBlock += `- Route Position: Stop ${tripContext.focusedWaypointIndex} of ${tripContext.totalWaypoints} on today's route\n`;
      }
      contextBlock += `- ID: ${focused.id}\n`;
      contextBlock += `- Name: ${focused.name}\n`;
      if (focused.place_name) contextBlock += `- Google Maps Place Name: ${focused.place_name}\n`;
      contextBlock += `- Category Type: ${focused.type}\n`;
      contextBlock += `- GPS Coordinates: ${focused.lat.toFixed(6)}, ${focused.lng.toFixed(6)}\n`;
      if (focused.address) contextBlock += `- Street Address / Location: ${focused.address}\n`;
      if (focused.google_place_id) contextBlock += `- Google Place ID: ${focused.google_place_id}\n`;
      if (focused.is_route_anchor !== undefined) contextBlock += `- Route-Forcing Anchor: ${focused.is_route_anchor ? 'Yes' : 'No'}\n`;
      if (tripContext.precedingWaypoint) {
        contextBlock += `- Preceding Stop: "${tripContext.precedingWaypoint.name}"${tripContext.precedingWaypoint.distanceMiles !== undefined ? ` (~${tripContext.precedingWaypoint.distanceMiles} mi earlier)` : ''}\n`;
      }
      if (tripContext.followingWaypoint) {
        contextBlock += `- Following Stop: "${tripContext.followingWaypoint.name}"${tripContext.followingWaypoint.distanceMiles !== undefined ? ` (~${tripContext.followingWaypoint.distanceMiles} mi ahead)` : ''}\n`;
      }
      if (focused.target_time) contextBlock += `- Scheduled Target Time: ${focused.target_time}\n`;
      if (focused.dwell_minutes !== undefined) contextBlock += `- Planned Dwell Duration: ${focused.dwell_minutes} minutes\n`;
      if (focused.drive_duration_minutes !== undefined && focused.drive_distance_miles !== undefined) {
        const mph = focused.drive_speed_mph ? ` (~${focused.drive_speed_mph} mph average speed)` : '';
        contextBlock += `- Driving Leg from Preceding Stop: ${focused.drive_duration_minutes} min, ${focused.drive_distance_miles} miles${mph}\n`;
      }
      if (focused.timezone) contextBlock += `- Local Timezone: ${focused.timezone}\n`;
      if (focused.trigger_radius_miles) contextBlock += `- Heads-Up Alert Radius: ${focused.trigger_radius_miles} miles\n`;
      if (focused.notes) contextBlock += `- Driver Notes: ${focused.notes}\n`;
      if (focused.notification) {
        contextBlock += `- Current Alert Title: "${focused.notification.title}"\n`;
        contextBlock += `- Current Spoken Audio: "${focused.notification.speech}"\n`;
      }
    } else {
      contextBlock += `Focused Waypoint ID: ${scope.waypointId || 'unknown'}\n`;
    }

    const otherWps = tripContext.waypoints.filter((w) => w.id !== scope.waypointId);
    if (otherWps.length > 0) {
      contextBlock += `\nOTHER STOPS ON THIS LEG FOR CONTEXT:\n`;
      otherWps.forEach((wp) => {
        contextBlock += `  - ${wp.name} (${wp.type}) @ ${wp.lat.toFixed(4)}, ${wp.lng.toFixed(4)}`;
        if (wp.notification) {
          contextBlock += ` | Alert: "${wp.notification.title}"`;
        }
        contextBlock += `\n`;
      });
    }
  }

  let conversationHistory = '';
  if (messages.length > 0) {
    conversationHistory = `\nCONVERSATION HISTORY:\n`;
    messages.forEach((msg) => {
      const sender = msg.role === 'user' ? 'User' : 'Route Scout';
      const cleanContent = msg.role === 'assistant' ? sanitize(msg.content) : msg.content;
      conversationHistory += `${sender}: ${cleanContent}\n\n`;
    });
  }

  return `MISSION & ROLE:
You are Route Scout, an expert scenic road-trip co-pilot and navigator embedded in the Roadtrip Co-Pilot Route Builder studio.
Your mission is to help the driver audit waypoints, discover scenic overlooks, find vetted meal and fuel stops along highway corridors, and verify route logistics.

GUIDELINES:
1. Provide practical, driver-oriented advice: parking accessibility (e.g. pull-offs vs steep lots), paved vs dirt roads, scenic value, pacing, daylight/golden hour timing, and local tips.
2. NEVER claim you added or changed a waypoint yourself. The human driver always has final approval. Suggest ideas naturally.
3. Keep responses conversational, concise, and helpful (typically 2-4 focused paragraphs).
4. When you recommend adding new stops, updating an existing waypoint's coordinates/dwell, or deleting a redundant or broken waypoint, append an exact structured JSON block at the very end using the format below. You are ABLE to emit multiple suggestion cards in the array when genuinely appropriate (for instance, if an audit warrants updating the current stop to a drive-by AND adding a specific recommended viewpoint/pull-off). However, do not force or spam multiple cards when a single targeted recommendation or simple reassurance is sufficient.
5. If no waypoint actions are needed (e.g. general questions or reassurance), do not include the json:suggestions block.
6. DRIVE-BY WAYPOINTS MUST NEVER LEAVE THE HIGHWAY:
   - A drive-by waypoint (or scenic pull-off intended as an in-transit notification trigger with 0m dwell) exists purely to trigger spoken audio or heads-up alerts from the app as the driver passes by.
   - A drive-by waypoint must NEVER take the driver off the highway. Its coordinates MUST lie directly on the active highway centerline or driving corridor.
   - Never set coordinates off the highway (e.g. on unpaved service roads, frontage roads, residential streets, or dirt tracks towards a distant landmark) because routing engines (OSRM, Google Maps) will treat that point as a destination and force an off-ramp exit, turnaround loop, or broken detour.
7. FUEL STOPS MUST BE VERIFIED COMMERCIAL SERVICE STATIONS:
   - A fuel stop must be an established, recognizable commercial brand (e.g. Maverik, Love's, Pilot, Flying J, Chevron, Shell, Speedway) with many fuel pumps, clean restrooms, and traveler amenities, located directly at a highway exit or on the main route.
   - NEVER suggest or accept coordinates in residential neighborhoods, trailer parks, or private roads. Always use the actual street address and verified coordinates of the commercial facility.
8. LOCATION TYPES (PHYSICAL STOPS VS IN-TRANSIT SCENIC TRIGGERS):
   - PHYSICAL STOPS (meal, fuel, lodging, scenic pull-off with parking):
     * Must be authentic, recognizable commercial facilities, official state/national park overlooks, or established visitor pull-offs with real addresses, entrances, and parking.
     * Always verify authentic coordinates so the driver is routed to the genuine parking lot or service station.
     * FINAL DESTINATION / LODGING OVERNIGHT DWELL: The final stop of a day's driving leg (especially lodging or destination) represents the overnight stay or trip conclusion. It is a physical stop and must be in Google Maps navigation, but does NOT have a scheduled departure on that day. Preserve dwell_minutes as 0 (or overnight) for the final stop rather than assigning an artificial 60-minute duration.
   - IN-TRANSIT SCENIC NOTIFICATION TRIGGERS (dwell == 0, scenic_drive_by):
     * These exist purely as in-car audio commentary and heads-up alert triggers on the highway. They are NOT destinations and do NOT require a commercial venue, visitor center, or formal cadastral land boundary.
     * If an official named scenic overlook or roadside turnout exists along the highway corridor, use it.
     * If the trigger marks a broad landscape transition (e.g. climbing into pine country, entering mountain foothills, or viewing a distant mesa), any high-confidence coordinate directly on the highway centerline where the scenic transition begins is 100% valid and desired.
     * Never perform cadastral land surveys, tribal boundary polygon calculations, or search for missing entrance signs for an in-transit scenic cue.
9. SCENIC DRIVE-BY PLACEMENT & DECOUPLING TITLES FROM SCENIC INTENT:
   - TIMING & PLACEMENT: In-transit scenic announcements must fire *at or before the beginning of the scenic transition* (e.g. where the highway begins its climb into the foothills or pines, or as a vista first comes into view), rather than near the end of the leg where the scenery is already behind the driver.
   - DECOUPLING TITLES FROM INTENT: Waypoint titles in draft itineraries often carry nearby town names (e.g. "Mountain Pass / Valley View") or legacy labels. Do not over-index on the title or assume the question is a forensic audit of the town's location. Focus on the experiential intent expressed in the driver's question, alert title, and spoken audio (e.g. "Climbing into Pine Country").
    - SYNCHRONIZE TITLE & AUDIO UPON RELOCATION: When relocating a scenic trigger earlier along the corridor (e.g. moving from a summit back to where the scenic highway ascent begins), enthusiastically update the waypoint title (e.g. "Climbing into Pine Country") and refresh the spoken audio to match the new location.
    - ANTICIPATORY FUTURE TENSE: In-transit spoken audio must ALWAYS use anticipatory future phrasing (e.g. "Approaching [Name] ahead...", "Coming up ahead in about half a mile...", "Prepare to see [Name] ahead..."). NEVER use present or past tense ("Now cruising along...", "Driving past...", "Passing...") because proximity alerts fire in advance before the vehicle reaches the point.
10. ROUTE AUDITING & REPAIR:
   - When the driver asks to audit the route or fix coordinates (e.g. "some waypoints take me off the highway", "the fuel stop is in a trailer park", or "fix drive-by points"), inspect all waypoints on the active day or focused stop.
   - Identify which waypoints depart from the highway or point to wrong locations, explain the error clearly to the driver, and emit concrete "update_waypoint" suggestion cards with the exact, verified highway coordinates and corrected names/dwells so the driver can apply the fixes with 1 click.
11. SYNCHRONIZE WAYPOINT ID, HEADS-UP NOTIFICATION & VOICE ALERT COPY:
   - When suggesting an "update_waypoint" or "add_waypoint", ALWAYS include an updated "notification" object containing:
     * "title": Short heads-up card title (<= 30 chars), formatted concisely (e.g. "Valley Park Picnic").
     * "message": In-car heads-up text (<= 2 lines), describing the upcoming stop, target time, and immediate highway direction.
     * "speech": Natural conversational spoken TTS audio script (15-25 words, ~10s speech duration). ALWAYS use anticipatory future tense ("Approaching [Name] ahead...", "Coming up ahead in about half a mile...", "Prepare to pull into [Name] ahead..."). NEVER use present or past tense ("Now cruising along...", "Driving past...", "Passing...") because proximity alerts fire ahead of the milestone. NEVER guess lateral orientation ("on your right" / "on your left") unless explicitly stated in user notes; default to neutral phrasing like "ahead" or "coming up". For in-transit drive-bys and route anchors, this audio and card is the driver's ONLY alert since non-anchor drive-bys do not appear as intermediate navigation stop pins on Google Maps.
   - CRITICAL NOTIFICATION CONSISTENCY:
     * If a waypoint's purpose, category, or name changes (for example, if what was originally a fuel stop is changed to a lunch stop at a park, or a scenic pull-off is changed to a meal break), the alert "title", "message", and "speech" MUST be completely rewritten to match the new purpose!
     * NEVER retain obsolete notification copy or audio scripts from the previous purpose (e.g. if a stop is now a picnic park or diner, the notification and spoken audio MUST NOT say "Fuel stop recommended" or refer to gas pumps).
   - WAYPOINT ID SYNCHRONIZATION:
     * If a waypoint's current ID reflects an obsolete purpose or old location (e.g. an ID of "stop_fuel" for a stop that is now "Valley Park (Picnic & Stretch)"), specify "newId" (e.g. "valley_park_picnic", in lowercase alphanumeric snake_case) so the underlying waypoint ID stays synchronized.
   - AUDITING ID & NOTIFICATION MISMATCHES:
     * When auditing waypoints, actively check whether a waypoint's ID or notification text conflicts with its name or category (e.g. an ID containing "fuel" when the category is "meal", or spoken audio announcing a fuel stop when arriving at a state park or diner).
     * Flag these contradictions clearly to the driver and emit an "update_waypoint" card with the corrected "newId" and updated "notification" copy to resolve the discrepancy.
12. GOOGLE MAPS NAVIGATION AUDITING & ROUTE ANCHORS:
   - When the driver asks to audit waypoints for Google Maps navigation, in-car accuracy, or route glitches (e.g. "some waypoints cause U-turns", "snapping to wrong side of divided highway", "wrong hotel entrance"):
     * ROUTE-FORCING ANCHORS VS SCENIC DRIVE-BYS (is_route_anchor):
       - A Route Anchor is specifically for in-transit pass-through milestones (dwell: 0m, scenic_drive_by) whose purpose is to steer Google Maps along a scenic highway corridor (e.g. AZ-179 through Sedona, Historic Route 66, US-89A) instead of an interstate bypass (I-17 or I-40).
       - OPERATIONAL "ONE ANCHOR PER CORRIDOR" RULE:
         1. DIVERGENT SCENIC BYWAY: When suggesting or auditing waypoints along a scenic byway, secondary highway, or mountain pass that runs parallel to or diverges from a faster freeway/interstate, mark the FIRST in-transit milestone entering that corridor with "is_route_anchor": true (dwell: 0m). This forces Google Maps to navigate via the scenic road.
         2. AUDIO COMMENTARY ONLY: Any subsequent scenic drive-bys, vistas, or audio cues along that SAME highway corridor must have "is_route_anchor": false (dwell: 0m). They will trigger in-car audio commentary and heads-up alerts from Roadtrip Co-Pilot without cluttering Google Maps navigation or consuming its 9-waypoint limit.
         3. PHYSICAL STOPS & ENDPOINTS: Never set "is_route_anchor": true on Physical Stops (lodging, meals, fuel, stop, overlooks with dwell > 0) or Origin/Destination. They are physical stopping destinations, already included in Google Maps navigation. Always set "is_route_anchor": false on them. Note that generic stops ("stop") are silent supply or errand milestones; do not generate heads-up notification copy or spoken prompts for them.
     * DIVIDED HIGHWAY HAZARDS:
       - Divided highways with central medians will force Google Maps into unwanted U-turns at roundabouts if an in-transit coordinate is placed slightly closer to the opposing curb or opposite storefront.
       - To fix this, place the anchor coordinate directly at a neutral roundabout center node or major highway intersection where traffic naturally flows through without U-turns, and set "is_route_anchor": true if it serves as a corridor pass-through milestone.
     * AUTHENTIC ENTRANCES FOR PHYSICAL STOPS (HOTELS, MEALS, FUEL, STOPS, OVERLOOKS):
       - ALWAYS provide clean establishment names in "place_name" for physical stops (lodging, meals, fuel, visitor centers) and POIs. While "name" is the human-facing display title (e.g. "Maverik (West Main St)", "Flagstaff / Little America Hotel"), "place_name" MUST be the clean, exact establishment title without parenthetical qualifiers or slash prefixes (e.g. "Maverik", "Little America Hotel", "Red Rock Park"). Google Maps navigation links rely on "place_name" to prevent ambiguous search prompts ("Did you mean:").
       - ALWAYS provide the verified street address in "address".
       - GOOGLE PLACE IDS: When researching via web search or official venue listings, if you discover an authentic Google Maps listing or URL containing a Place ID or 0x...:0x... entity, include the authentic "google_place_id". Never invent or guess arbitrary Place IDs from memory. The app automatically validates all Place IDs against Google's binary protobuf schema before accepting them.
       - For scenic overlooks with parking, place coordinates on the paved visitor parking lot / access drive, NOT out on a pedestrian cliff rim or hiking trail.
     * FINAL LODGING & DESTINATION OVERNIGHT STOPS:
       - The final stop of a day's driving route is the overnight destination. It does not have a departure time. Preserve dwell_minutes as 0 (overnight) for final lodging stops.
     * KEEP AUDITING FAST & LEAN:
       - You do NOT need to perform forensic sub-meter lane calculations or run loops. Provide an authentic commercial address, recognizable roundabout/junction coordinate, and clean highway placement.
13. AUDIT LEG DRIVING SPEEDS & OFF-HIGHWAY ANOMALIES:
   - When evaluating schedules, daylight timing, or answering driver questions about pacing and stops, inspect the "Leg Drive" duration, distance, and average speed (mph) between consecutive waypoints.
   - Normal highway cruising legs average 50-65 mph.
   - If a driving leg between highway waypoints shows an unusually low average speed (< 25-30 mph) over a multi-mile distance along an active highway corridor, warn the driver that the preceding or target waypoint is likely misplaced off the highway on unpaved dirt tracks or residential streets rather than on the highway centerline.

JSON SUGGESTIONS BLOCK FORMAT (Append at the end if making concrete recommendations):
\`\`\`json:suggestions
[
  {
    "action": "add_waypoint",
    "name": "AZ-179 / Red Rock Scenic Byway",
    "place_name": "Red Rock Scenic Byway",
    "type": "scenic_drive_by",
    "lat": 34.7891,
    "lng": -111.7654,
    "dwell_minutes": 0,
    "trigger_radius_miles": 2.0,
    "is_route_anchor": true,
    "insertAfterWaypointId": "optional_preceding_waypoint_id",
    "reason": "Locks Google Maps along scenic AZ-179 corridor instead of I-17 bypass.",
    "notification": {
      "title": "Red Rock Scenic Byway",
      "message": "Approaching AZ-179 scenic corridor into Sedona.",
      "speech": "Approaching Red Rock Scenic Byway on Highway one seventy-nine ahead."
    }
  },
  {
    "action": "update_waypoint",
    "targetWaypointId": "target_id",
    "newId": "updated_id_snake_case",
    "name": "Updated Human-Friendly Name",
    "place_name": "Clean Establishment Name",
    "type": "meal",
    "lat": 35.5678,
    "lng": -111.1234,
    "dwell_minutes": 30,
    "trigger_radius_miles": 3.0,
    "address": "456 Main St, City, ST 12345",
    "google_place_id": "ChIJ...",
    "is_route_anchor": false,
    "reason": "Explanation of the correction or improvement.",
    "notification": {
      "title": "Short Title (<=30 chars)",
      "message": "Heads-up alert text (<=2 lines)",
      "speech": "Natural conversational spoken TTS audio (15-25 words, ~10s)"
    }
  },
  {
    "action": "delete_waypoint",
    "targetWaypointId": "target_id",
    "reason": "Explanation for removing this redundant or broken stop."
  }
]
\`\`\`

Allowed types: "origin", "destination", "scenic_pull_off", "scenic_drive_by", "meal", "fuel", "lodging", "stop".

${contextBlock}
${conversationHistory}
Please respond to the latest User request.`;
}

/**
 * Builds the default Route Scout prompt.
 * Decorates the domain prompt with the active provider's harness directives.
 */
export function buildScoutPrompt(request: ScoutChatRequest, adapter?: AiHarnessAdapter): string {
  const sanitize = adapter ? (value: string) => adapter.sanitizeResponse(value) : undefined;
  const domainPrompt = buildScoutDomainPrompt(request, sanitize);
  if (adapter) {
    return adapter.decorateScoutPrompt(domainPrompt);
  }
  return domainPrompt;
}

/**
 * Separates intermediate tool-calling or reasoning preambles from the final answer.
 * `sanitize` is supplied by the active provider adapter; the default is identity so
 * this parser stays provider-agnostic.
 */
export function separateThoughtAndReply(
  text: string,
  sanitize: (value: string) => string = (value) => value
): { thought?: string; reply: string } {
  const sanitized = sanitize(text);

  // Matches agent preambles (e.g. "I have launched a query...", "I will analyze...") before markdown heading or main body
  const multiLineRegex = /^((?:I (?:have launched|am checking|am inspecting|will analyze|will inspect|will check|have initiated|need to inspect)[^\n]+(?:\n+|$))+)\n*([\s\S]*)$/i;
  const match = sanitized.match(multiLineRegex);
  if (match && match[1] && match[2] && match[2].trim().length > 0) {
    return {
      thought: match[1].trim(),
      reply: sanitize(match[2]),
    };
  }

  const singlePreambleRegex = /^(?:I have launched a query[^.\n]*\.[^.\n]*\.\s*|I will analyze the results as soon as they return\.\s*|Let me inspect[^.\n]*\.\s*)/i;
  const singleMatch = sanitized.match(singlePreambleRegex);
  if (singleMatch && singleMatch[0]) {
    const thought = singleMatch[0].trim();
    const reply = sanitize(sanitized.slice(singleMatch[0].length));
    if (reply.length > 0) {
      return { thought, reply };
    }
  }

  return { reply: sanitized };
}

/**
 * Hydrates an AI suggestion with verified establishment names, addresses,
 * Google Place IDs, and authentic physical entrance coordinates from grounded tool calls.
 * Never mutates the input suggestion object.
 */
export function hydrateSuggestionFromResolvedPlaces(
  suggestion: ScoutSuggestion,
  resolvedPlaces?: ResolvedPlaceRecord[],
  knownPlaceIds?: Set<string>
): ScoutSuggestion {
  const result: ScoutSuggestion = { ...suggestion };
  if (!resolvedPlaces || resolvedPlaces.length === 0) return result;

  let matched: ResolvedPlaceRecord | undefined;

  // 1. Exact google_place_id match.
  // If suggestion.google_place_id is already set, ONLY match a record with that exact Place ID
  // so we never cross-pollinate Place ID of A with coordinates/address of B (F-32).
  if (result.google_place_id) {
    matched = resolvedPlaces.find((r) => r.google_place_id === result.google_place_id);
  } else {
    // 2. Normalized name match
    const sugName = cleanPlaceName(result.place_name || result.name).toLowerCase();
    if (sugName) {
      // 2a. Prefer exact normalized equality
      matched = resolvedPlaces.find((r) => {
        const rPlace = r.place_name.toLowerCase();
        const rDisplay = cleanPlaceName(r.display_name).toLowerCase();
        return (
          (rPlace.length > 0 && rPlace === sugName) ||
          (rDisplay.length > 0 && rDisplay === sugName)
        );
      });

      // 2b. Only fall back to substring containment if >= 4 chars and unambiguously matches a single record
      if (!matched && sugName.length >= 4) {
        const substringMatches = resolvedPlaces.filter((r) => {
          const rPlace = r.place_name.toLowerCase();
          return (
            rPlace.length >= 4 &&
            (rPlace.includes(sugName) || sugName.includes(rPlace))
          );
        });
        if (substringMatches.length === 1) {
          matched = substringMatches[0];
        }
      }
    }

    // 3. Proximity match (<= 0.15 miles) strictly for commercial physical stop additions
    // when unambiguously matching at most 1 resolved place (F-31).
    const isCommercialStop =
      result.type === 'meal' || result.type === 'fuel' || result.type === 'lodging';
    if (
      !matched &&
      result.action === 'add_waypoint' &&
      isCommercialStop &&
      !result.is_route_anchor
    ) {
      const proximityCandidates = resolvedPlaces.filter(
        (r) => haversineMiles(result.lat, result.lng, r.lat, r.lng) <= 0.15
      );
      if (proximityCandidates.length === 1) {
        matched = proximityCandidates[0];
      }
    }
  }

  if (matched) {
    if (
      !result.google_place_id &&
      matched.google_place_id &&
      validateScoutPlaceId(matched.google_place_id, knownPlaceIds)
    ) {
      result.google_place_id = matched.google_place_id;
    }
    if (!result.place_name && matched.place_name) {
      result.place_name = matched.place_name;
    }
    if (!result.address && matched.address) {
      result.address = matched.address;
    }
    // Only overwrite coordinates for commercial physical stops (meal, fuel, lodging)
    // so scenic_pull_off and scenic_drive_by pins are never moved off their overlook/highway coordinate.
    if (
      (result.type === 'meal' || result.type === 'fuel' || result.type === 'lodging') &&
      !result.is_route_anchor
    ) {
      result.lat = Number(matched.lat.toFixed(6));
      result.lng = Number(matched.lng.toFixed(6));
    }
  }

  return result;
}

/**
 * Parses Route Scout output, extracting markdown conversation and structured suggestion actions.
 */
export function parseScoutResponse(
  rawOutput: string,
  options?: {
    knownPlaceIds?: Set<string>;
    resolvedPlaces?: ResolvedPlaceRecord[];
    tripWaypoints?: ScoutWaypointSummary[];
    sanitize?: (value: string) => string;
  }
): { reply: string; suggestions: ScoutSuggestion[]; thought?: string } {
  if (!rawOutput || rawOutput.trim().length === 0) {
    throw new MalformedAiResponseError('AI provider returned an empty Route Scout response');
  }

  let reply = rawOutput.trim();
  const suggestions: ScoutSuggestion[] = [];

  const hasSuggestionsTag = /```(?:json:suggestions)\b/i.test(rawOutput);
  const closedExplicitBlock = rawOutput.match(/```(?:json:suggestions)\s*([\s\S]*?)\s*```/i);

  if (hasSuggestionsTag && !closedExplicitBlock) {
    throw new MalformedAiResponseError('AI response contained an incomplete or truncated suggestions block');
  }

  const genericMatch = !closedExplicitBlock
    ? rawOutput.match(/```(?:json)?\s*(\[\s*\{[\s\S]*?\}\s*\])\s*```/i)
    : null;

  const matchedBlockString = closedExplicitBlock ? closedExplicitBlock[0] : (genericMatch ? genericMatch[0] : '');
  const rawJson = closedExplicitBlock ? closedExplicitBlock[1] : (genericMatch ? genericMatch[1] : null);

  if (rawJson !== null) {
    const trimmedJson = rawJson.trim();
    if (trimmedJson.length === 0) {
      if (hasSuggestionsTag) {
        throw new MalformedAiResponseError('AI response contained an empty suggestions block');
      }
    } else {
      try {
        const parsedArray = JSON.parse(trimmedJson);
        if (!Array.isArray(parsedArray)) {
          if (hasSuggestionsTag) {
            throw new MalformedAiResponseError('AI response suggestions block did not contain a JSON array');
          }
        } else {
          parsedArray.forEach((item, index) => {
          if (
            typeof item === 'object' &&
            item !== null &&
            (item.action === 'add_waypoint' || item.action === 'update_waypoint')
          ) {
            const targetWaypointId =
              typeof item.targetWaypointId === 'string' && item.targetWaypointId.trim().length > 0
                ? item.targetWaypointId.trim()
                : typeof item.target_waypoint_id === 'string' && item.target_waypoint_id.trim().length > 0
                ? item.target_waypoint_id.trim()
                : undefined;

            const matchedWp =
              item.action === 'update_waypoint' && targetWaypointId && options?.tripWaypoints
                ? options.tripWaypoints.find((w) => w.id === targetWaypointId)
                : undefined;

            const place_name =
              typeof item.place_name === 'string' && item.place_name.trim().length > 0
                ? item.place_name.trim()
                : typeof item.placeName === 'string' && item.placeName.trim().length > 0
                ? item.placeName.trim()
                : undefined;

            const rawPlaceId =
              typeof item.google_place_id === 'string' && item.google_place_id.trim().length > 0
                ? item.google_place_id.trim()
                : typeof item.placeId === 'string' && item.placeId.trim().length > 0
                ? item.placeId.trim()
                : undefined;

            const validatedPlaceId = validateScoutPlaceId(rawPlaceId, options?.knownPlaceIds);

            // Backfill missing coordinates from resolvedPlaces or matchedWp when omitted by the model (F-35)
            let resolvedLat: number | undefined =
              typeof item.lat === 'number' && Number.isFinite(item.lat) ? item.lat : undefined;
            let resolvedLng: number | undefined =
              typeof item.lng === 'number' && Number.isFinite(item.lng) ? item.lng : undefined;

            if ((resolvedLat === undefined || resolvedLng === undefined) && options?.resolvedPlaces) {
              const candidateName = cleanPlaceName(
                place_name || (typeof item.name === 'string' ? item.name : '')
              ).toLowerCase();
              const matchedPlace = options.resolvedPlaces.find((r) => {
                if (validatedPlaceId && r.google_place_id === validatedPlaceId) return true;
                if (!validatedPlaceId && candidateName.length > 0) {
                  const rPlace = r.place_name.toLowerCase();
                  const rDisplay = cleanPlaceName(r.display_name).toLowerCase();
                  return rPlace === candidateName || rDisplay === candidateName;
                }
                return false;
              });
              if (matchedPlace) {
                resolvedLat = matchedPlace.lat;
                resolvedLng = matchedPlace.lng;
              }
            }

            if ((resolvedLat === undefined || resolvedLng === undefined) && matchedWp) {
              resolvedLat = matchedWp.lat;
              resolvedLng = matchedWp.lng;
            }

            if (
              resolvedLat === undefined ||
              resolvedLng === undefined ||
              !Number.isFinite(resolvedLat) ||
              !Number.isFinite(resolvedLng) ||
              resolvedLat < -90 ||
              resolvedLat > 90 ||
              resolvedLng < -180 ||
              resolvedLng > 180
            ) {
              return;
            }

            const newId =
              typeof item.newId === 'string' && item.newId.trim().length > 0
                ? item.newId.trim()
                : typeof item.new_id === 'string' && item.new_id.trim().length > 0
                ? item.new_id.trim()
                : undefined;

            const rawIsAnchor =
              typeof item.is_route_anchor === 'boolean'
                ? item.is_route_anchor
                : typeof item.isRouteAnchor === 'boolean'
                ? item.isRouteAnchor
                : undefined;

            const resolvedType =
              typeof item.type === 'string' && item.type.trim().length > 0
                ? item.type.trim()
                : matchedWp?.type || 'scenic_pull_off';

            const resolvedDwellMinutes =
              typeof item.dwell_minutes === 'number' && Number.isFinite(item.dwell_minutes) && item.dwell_minutes >= 0
                ? item.dwell_minutes
                : matchedWp && typeof matchedWp.dwell_minutes === 'number'
                ? matchedWp.dwell_minutes
                : resolvedType === 'scenic_drive_by'
                ? 0
                : 15;

            // Physical stops (lodging, meal, fuel, stop, origin, destination, or explicit dwell > 0) are NEVER pass-through anchors
            const isPhysical =
              resolvedType === 'lodging' ||
              resolvedType === 'meal' ||
              resolvedType === 'fuel' ||
              resolvedType === 'stop' ||
              resolvedType === 'origin' ||
              resolvedType === 'destination' ||
              (typeof item.dwell_minutes === 'number' && item.dwell_minutes > 0);

            const is_route_anchor = isPhysical ? false : rawIsAnchor;

            const baseSug: ScoutSuggestion = {
              id: `scout_sug_${Date.now()}_${index}`,
              action: item.action,
              name:
                typeof item.name === 'string' && item.name.trim().length > 0
                  ? item.name
                  : matchedWp?.name || 'Suggested Stop',
              place_name,
              type: resolvedType,
              lat: Number(resolvedLat.toFixed(6)),
              lng: Number(resolvedLng.toFixed(6)),
              dwell_minutes: resolvedDwellMinutes,
              trigger_radius_miles:
                typeof item.trigger_radius_miles === 'number' && Number.isFinite(item.trigger_radius_miles)
                  ? item.trigger_radius_miles
                  : matchedWp?.trigger_radius_miles ?? 2.0,
              reason: typeof item.reason === 'string' ? item.reason : 'Recommended by Route Scout',
              insertAfterWaypointId:
                typeof item.insertAfterWaypointId === 'string' ? item.insertAfterWaypointId : undefined,
              targetWaypointId,
              newId,
              address:
                typeof item.address === 'string' && item.address.trim().length > 0
                  ? item.address.trim()
                  : undefined,
              google_place_id: validatedPlaceId,
              is_route_anchor,
              notification:
                resolvedType !== 'stop' &&
                typeof item.notification === 'object' && item.notification !== null
                  ? {
                      title: typeof item.notification.title === 'string' ? item.notification.title : '',
                      message: typeof item.notification.message === 'string' ? item.notification.message : '',
                      speech: typeof item.notification.speech === 'string' ? item.notification.speech : '',
                    }
                  : undefined,
            };
            const hydrated = hydrateSuggestionFromResolvedPlaces(
              baseSug,
              options?.resolvedPlaces,
              options?.knownPlaceIds
            );
            suggestions.push(hydrated);
          } else if (
            typeof item === 'object' &&
            item !== null &&
            item.action === 'delete_waypoint'
          ) {
            const targetWaypointId =
              typeof item.targetWaypointId === 'string' && item.targetWaypointId.trim().length > 0
                ? item.targetWaypointId.trim()
                : typeof item.target_waypoint_id === 'string' && item.target_waypoint_id.trim().length > 0
                ? item.target_waypoint_id.trim()
                : undefined;

            if (!targetWaypointId || suggestions.some((s) => s.action === 'delete_waypoint' && s.targetWaypointId === targetWaypointId)) {
              return;
            }

            const matchedWp = options?.tripWaypoints?.find((w) => w.id === targetWaypointId);
            // When tripWaypoints are provided, strictly require targetWaypointId to exist in tripWaypoints
            // and take authoritative name/type/lat/lng from matchedWp to prevent card spoofing or (0,0) Null Island (F-34).
            if (options?.tripWaypoints && options.tripWaypoints.length > 0 && !matchedWp) {
              return;
            }

            const lat = matchedWp
              ? Number(matchedWp.lat.toFixed(6))
              : typeof item.lat === 'number' && Number.isFinite(item.lat)
              ? Number(item.lat.toFixed(6))
              : 0;
            const lng = matchedWp
              ? Number(matchedWp.lng.toFixed(6))
              : typeof item.lng === 'number' && Number.isFinite(item.lng)
              ? Number(item.lng.toFixed(6))
              : 0;
            const name = matchedWp
              ? matchedWp.name
              : typeof item.name === 'string' && item.name.trim().length > 0
              ? item.name.trim()
              : 'Remove Stop';
            const type = matchedWp
              ? matchedWp.type
              : typeof item.type === 'string' && item.type.trim().length > 0
              ? item.type.trim()
              : 'stop';
            const reason =
              typeof item.reason === 'string' && item.reason.trim().length > 0
                ? item.reason.trim()
                : 'Recommended for removal by Route Scout';

            suggestions.push({
              id: `scout_sug_${Date.now()}_${index}`,
              action: 'delete_waypoint',
              name,
              type,
              lat,
              lng,
              targetWaypointId,
              reason,
            });
          }
        });
      }
      // Strip the code block from the user-facing text
      reply = (matchedBlockString ? rawOutput.replace(matchedBlockString, '') : rawOutput).trim();
    } catch (err: unknown) {
      if (err instanceof MalformedAiResponseError) throw err;
      if (hasSuggestionsTag) {
        throw new MalformedAiResponseError('AI response contained an unparseable suggestions block');
      }
      // If parsing fails on generic json block, preserve raw output
    }
  }
}

  const separated = separateThoughtAndReply(reply, options?.sanitize);
  return {
    reply: separated.reply,
    suggestions,
    thought: separated.thought,
  };
}

/**
 * Returns contextual quick-tap prompt chips based on active scope.
 */
export function getQuickPrompts(scope: ScoutScope): string[] {
  if (scope.type === 'waypoint') {
    const name = scope.waypointName || 'this stop';
    return [
      `Check Google Maps navigation & address for ${name}`,
      `Is the coordinate for ${name} directly on the highway?`,
      `Check if alert notification and speech match ${name}`,
      `Check parking and road accessibility for ${name}`,
      `Suggest a better scenic overlook or photo spot near ${name}`,
      `Is our planned dwell time appropriate for ${name}?`,
    ];
  }

  return [
    'Where should we stop for lunch along this leg?',
    'Audit route for Google Maps navigation, detours & stop accuracy',
    'What scenic pull-offs exist on this corridor?',
    'Check for long fuel deserts or remote stretches',
    'How is our overall driving pace today?',
  ];
}

export interface ScoutServiceOptions {
  aiService?: AiService;
  tools?: ToolDeclaration[];
  toolDispatcher?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  toolLibrary?: ScoutToolLibrary;
  toolLibraryOptions?: ScoutToolLibraryOptions;
}

/**
 * Route Scout Service Coordinator.
 */
export class ScoutService {
  public readonly aiService: AiService;
  private tools: ToolDeclaration[];
  private customToolDispatcher?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  private toolLibrary: ScoutToolLibrary;

  constructor(aiServiceOrOptions?: AiService | ScoutServiceOptions) {
    if (aiServiceOrOptions instanceof AiService) {
      this.aiService = aiServiceOrOptions;
      this.tools = SCOUT_TOOL_DECLARATIONS;
      this.toolLibrary = new ScoutToolLibrary();
    } else if (aiServiceOrOptions && typeof aiServiceOrOptions === 'object') {
      this.aiService = aiServiceOrOptions.aiService || createDefaultAiService();
      this.tools = aiServiceOrOptions.tools ?? SCOUT_TOOL_DECLARATIONS;
      this.customToolDispatcher = aiServiceOrOptions.toolDispatcher;
      this.toolLibrary =
        aiServiceOrOptions.toolLibrary ?? new ScoutToolLibrary(aiServiceOrOptions.toolLibraryOptions);
    } else {
      this.aiService = createDefaultAiService();
      this.tools = SCOUT_TOOL_DECLARATIONS;
      this.toolLibrary = new ScoutToolLibrary();
    }
  }

  private recordCustomToolGrounding(
    name: string,
    _args: Record<string, unknown>,
    result: unknown,
    cache: TurnGroundingCache
  ): void {
    if (name !== 'resolve_and_standardize_place' || !result || typeof result !== 'object') {
      return;
    }
    const obj = result as Record<string, unknown>;
    const list: unknown[] = [];
    if (Array.isArray(obj.places)) {
      list.push(...obj.places);
    } else if (obj.best_match && typeof obj.best_match === 'object') {
      list.push(obj.best_match);
    }
    for (const item of list) {
      if (typeof item === 'object' && item !== null) {
        const rec = item as Partial<ResolvedPlaceRecord>;
        if (
          typeof rec.place_name === 'string' &&
          rec.place_name.trim().length > 0 &&
          typeof rec.lat === 'number' &&
          Number.isFinite(rec.lat) &&
          rec.lat >= -90 &&
          rec.lat <= 90 &&
          typeof rec.lng === 'number' &&
          Number.isFinite(rec.lng) &&
          rec.lng >= -180 &&
          rec.lng <= 180
        ) {
          const validPlaceId =
            typeof rec.google_place_id === 'string' && isValidGooglePlaceId(rec.google_place_id)
              ? rec.google_place_id.trim()
              : undefined;
          cache.resolvedPlaces.push({
            query: typeof rec.query === 'string' ? rec.query : rec.place_name,
            place_name: rec.place_name.trim(),
            display_name: typeof rec.display_name === 'string' ? rec.display_name : rec.place_name.trim(),
            address: typeof rec.address === 'string' ? rec.address : '',
            lat: rec.lat,
            lng: rec.lng,
            google_place_id: validPlaceId,
            types: Array.isArray(rec.types)
              ? rec.types.filter((t): t is string => typeof t === 'string')
              : undefined,
            weekday_descriptions: Array.isArray(rec.weekday_descriptions)
              ? rec.weekday_descriptions.filter((d): d is string => typeof d === 'string')
              : undefined,
          });
          if (validPlaceId) {
            cache.knownPlaceIds.add(validPlaceId);
          }
        }
      }
    }
  }

  async validateModelId(
    modelId?: string,
    preferredEngine?: string,
    role: 'scout' | 'copywriter' = 'scout'
  ): Promise<string | undefined> {
    return this.aiService.validateModelId(modelId, preferredEngine, role);
  }

  async resolveModelId(modelId?: string, preferredEngine?: string): Promise<string> {
    return this.aiService.resolveModelId(modelId, 'scout', preferredEngine);
  }

  validateProvider(preferredEngine?: string): AiHarnessAdapter {
    return this.aiService.getAdapterFor(preferredEngine);
  }

  /**
   * Executes a multi-turn chat interaction with Route Scout.
   */
  async chat(request: ScoutChatRequest, options: GenerationOptions = {}): Promise<ScoutChatResponse> {
    const effectiveModelId = options.modelId !== undefined ? options.modelId : request.modelId;
    const preferredEngine = options.preferredEngine ?? request.preferredEngine;
    const adapter = this.aiService.getAdapterFor(preferredEngine);

    if (!(await adapter.isAvailable(options.apiKey))) {
      throw new Error(`${adapter.name} is currently unavailable.`);
    }

    const activeModelId = await this.resolveModelId(effectiveModelId, preferredEngine);

    const sessionId = request.sessionId || `scout_${Date.now()}`;
    const sanitize = (text: string) => adapter.sanitizeResponse(text);
    const domainPrompt = adapter.decorateScoutPrompt(buildScoutDomainPrompt(request, sanitize));

    const groundingCache = createTurnGroundingCache(request.tripContext?.waypoints);

    const turnDispatcher = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      if (this.customToolDispatcher) {
        const customRes = await this.customToolDispatcher(name, args);
        this.recordCustomToolGrounding(name, args, customRes, groundingCache);
        return customRes;
      }
      return this.toolLibrary.executeTool(name, args, {
        tripContext: request.tripContext,
        scope: request.scope,
        abortSignal: options.abortSignal,
        groundingCache,
      });
    };

    if (adapter.generateStreamWithTools) {
      const streamRes = await adapter.generateStreamWithTools(
        domainPrompt,
        this.tools,
        turnDispatcher,
        () => {},
        { modelId: activeModelId, abortSignal: options.abortSignal }
      );
      const { reply, suggestions, thought } = parseScoutResponse(
        adapter.sanitizeResponse(streamRes.text),
        {
          knownPlaceIds: groundingCache.knownPlaceIds,
          resolvedPlaces: groundingCache.resolvedPlaces,
          tripWaypoints: request.tripContext?.waypoints,
          sanitize,
        }
      );
      return {
        reply,
        suggestions,
        sessionId,
        engine: adapter.id,
        thought,
        modelId: activeModelId,
        inputTokens: streamRes.inputTokens,
        outputTokens: streamRes.outputTokens,
      };
    }

    const rawOutput = await adapter.generate(domainPrompt, {
      modelId: activeModelId,
      abortSignal: options.abortSignal,
    });
    const { reply, suggestions, thought } = parseScoutResponse(
      adapter.sanitizeResponse(rawOutput),
      {
        knownPlaceIds: groundingCache.knownPlaceIds,
        resolvedPlaces: groundingCache.resolvedPlaces,
        tripWaypoints: request.tripContext?.waypoints,
        sanitize,
      }
    );
    return {
      reply,
      suggestions,
      sessionId,
      engine: adapter.id,
      thought,
      modelId: activeModelId,
    };
  }

  /**
   * Executes a streaming multi-turn chat interaction with Route Scout over SSE.
   */
  async chatStream(
    request: ScoutChatRequest,
    onEvent: (event: ScoutStreamEvent) => void,
    options: GenerationOptions = {}
  ): Promise<ScoutChatResponse> {
    const effectiveModelId = options.modelId !== undefined ? options.modelId : request.modelId;
    const preferredEngine = options.preferredEngine ?? request.preferredEngine;
    const adapter = this.aiService.getAdapterFor(preferredEngine);

    if (!(await adapter.isAvailable(options.apiKey))) {
      throw new Error(`${adapter.name} is currently unavailable.`);
    }

    if (!adapter.generateStreamWithTools) {
      throw new Error(`${adapter.name} does not support streaming responses`);
    }

    const activeModelId = await this.resolveModelId(effectiveModelId, preferredEngine);

    const sessionId = request.sessionId || `scout_${Date.now()}`;
    const sanitize = (text: string) => adapter.sanitizeResponse(text);
    const domainPrompt = adapter.decorateScoutPrompt(buildScoutDomainPrompt(request, sanitize));

    const groundingCache = createTurnGroundingCache(request.tripContext?.waypoints);

    const turnDispatcher = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      if (this.customToolDispatcher) {
        const customRes = await this.customToolDispatcher(name, args);
        this.recordCustomToolGrounding(name, args, customRes, groundingCache);
        return customRes;
      }
      return this.toolLibrary.executeTool(name, args, {
        tripContext: request.tripContext,
        scope: request.scope,
        abortSignal: options.abortSignal,
        groundingCache,
      });
    };

    const activities: ScoutActivity[] = [];
    const streamRes = await adapter.generateStreamWithTools(
      domainPrompt,
      this.tools,
      turnDispatcher,
      (streamEvt) => {
        if (options.abortSignal?.aborted) return;
        if (streamEvt.event === 'activity') {
          const existingIdx = activities.findIndex((a) => a.id === streamEvt.data.id);
          if (existingIdx >= 0) {
            activities[existingIdx] = streamEvt.data;
          } else {
            activities.push(streamEvt.data);
          }
          onEvent(streamEvt);
        } else if (streamEvt.event === 'thought' || streamEvt.event === 'delta') {
          onEvent(streamEvt);
        }
      },
      { modelId: activeModelId, abortSignal: options.abortSignal }
    );

    if (options.abortSignal?.aborted) {
      throw new Error('Request aborted');
    }

    const { reply, suggestions, thought } = parseScoutResponse(
      adapter.sanitizeResponse(streamRes.text),
      {
        knownPlaceIds: groundingCache.knownPlaceIds,
        resolvedPlaces: groundingCache.resolvedPlaces,
        tripWaypoints: request.tripContext?.waypoints,
        sanitize,
      }
    );
    if (suggestions.length > 0) {
      onEvent({ event: 'suggestions', data: { suggestions } });
    }
    const doneResponse: ScoutChatResponse = {
      reply,
      suggestions,
      sessionId,
      engine: adapter.id,
      thought,
      activities: activities.length > 0 ? activities : undefined,
      modelId: activeModelId,
      inputTokens: streamRes.inputTokens,
      outputTokens: streamRes.outputTokens,
    };
    onEvent({ event: 'done', data: doneResponse });
    return doneResponse;
  }

  /**
   * Returns contextual quick prompts for a scope.
   */
  getQuickPrompts(scope: ScoutScope): string[] {
    return getQuickPrompts(scope);
  }
}
