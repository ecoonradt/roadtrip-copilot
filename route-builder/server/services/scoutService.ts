import type {
  ScoutScope,
  ScoutSuggestion,
  ScoutChatRequest,
  ScoutChatResponse,
  ScoutStreamEvent,
  ScoutActivity,
} from '../types/scout.js';
import type { GenerationOptions, AiHarnessAdapter } from './aiService.js';
import { AiService, AgyHarnessAdapter } from './aiService.js';

/**
 * Builds the comprehensive domain prompt for Route Scout (pure road-trip domain, harness-agnostic).
 */
export function buildScoutDomainPrompt(request: ScoutChatRequest): string {
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
      const cleanContent = msg.role === 'assistant' ? sanitizeScoutReply(msg.content) : msg.content;
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
4. When you recommend adding new stops or updating an existing waypoint's coordinates/dwell, append an exact structured JSON block at the very end using the format below. You are ABLE to emit multiple suggestion cards in the array when genuinely appropriate (for instance, if an audit warrants updating the current stop to a drive-by AND adding a specific recommended viewpoint/pull-off). However, do not force or spam multiple cards when a single targeted recommendation or simple reassurance is sufficient.
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
    - ANTICIPATORY FUTURE TENSE: In-transit spoken audio must ALWAYS use anticipatory future phrasing (e.g. "Approaching...", "Coming up ahead on your right in about half a mile...", "Prepare to see..."). NEVER use present or past tense ("Now cruising along...", "Driving past...", "Passing...") because proximity alerts fire in advance before the vehicle reaches the point.
10. ROUTE AUDITING & REPAIR:
   - When the driver asks to audit the route or fix coordinates (e.g. "some waypoints take me off the highway", "the fuel stop is in a trailer park", or "fix drive-by points"), inspect all waypoints on the active day or focused stop.
   - Identify which waypoints depart from the highway or point to wrong locations, explain the error clearly to the driver, and emit concrete "update_waypoint" suggestion cards with the exact, verified highway coordinates and corrected names/dwells so the driver can apply the fixes with 1 click.
11. SYNCHRONIZE WAYPOINT ID, HEADS-UP NOTIFICATION & VOICE ALERT COPY:
   - When suggesting an "update_waypoint" or "add_waypoint", ALWAYS include an updated "notification" object containing:
     * "title": Short heads-up card title (<= 30 chars), formatted concisely (e.g. "Valley Park Picnic").
     * "message": In-car heads-up text (<= 2 lines), describing the upcoming stop, target time, and immediate highway direction.
     * "speech": Natural conversational spoken TTS audio script (15-25 words, ~10s speech duration). ALWAYS use anticipatory future tense ("Approaching [Name] on your right...", "Coming up ahead in about half a mile...", "Prepare to see..."). NEVER use present or past tense ("Now cruising along...", "Driving past...", "Passing...") because proximity alerts fire ahead of the milestone. For in-transit drive-bys and route anchors, this audio and card is the driver's ONLY alert since non-anchor drive-bys do not appear as intermediate navigation stop pins on Google Maps.
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
         3. PHYSICAL STOPS & ENDPOINTS: Never set "is_route_anchor": true on Physical Stops (lodging, meals, fuel, overlooks with dwell > 0) or Origin/Destination. They are physical stopping destinations, already included in Google Maps navigation. Always set "is_route_anchor": false on them.
     * DIVIDED HIGHWAY HAZARDS:
       - Divided highways with central medians will force Google Maps into unwanted U-turns at roundabouts if an in-transit coordinate is placed slightly closer to the opposing curb or opposite storefront.
       - To fix this, place the anchor coordinate directly at a neutral roundabout center node or major highway intersection where traffic naturally flows through without U-turns, and set "is_route_anchor": true if it serves as a corridor pass-through milestone.
     * AUTHENTIC ENTRANCES FOR PHYSICAL STOPS (HOTELS, MEALS, FUEL, OVERLOOKS):
       - ALWAYS provide clean establishment names in "place_name" for physical stops (lodging, meals, fuel, visitor centers) and POIs. While "name" is the human-facing display title (e.g. "Maverik (West Main St)", "Flagstaff / Little America Hotel"), "place_name" MUST be the clean, exact establishment title without parenthetical qualifiers or slash prefixes (e.g. "Maverik", "Little America Hotel", "Red Rock Park"). Google Maps navigation links rely on "place_name" to prevent ambiguous search prompts ("Did you mean:").
       - ALWAYS provide the verified street address in "address".
       - GOOGLE PLACE IDS: When researching via web search or official venue listings, if you discover an authentic Google Maps listing or URL containing a Place ID or 0x...:0x... entity, include the authentic "google_place_id". Never invent or guess arbitrary Place IDs from memory. The app automatically validates all Place IDs against Google's binary protobuf schema before accepting them.
       - For scenic overlooks with parking, place coordinates on the paved visitor parking lot / access drive, NOT out on a pedestrian cliff rim or hiking trail.
     * FINAL LODGING & DESTINATION OVERNIGHT STOPS:
       - The final stop of a day's driving route is the overnight destination. It does not have a departure time. Preserve dwell_minutes as 0 (overnight) for final lodging stops.
     * KEEP AUDITING FAST & LEAN:
       - You do NOT need to perform forensic sub-meter lane calculations or run loops. Provide an authentic commercial address, recognizable roundabout/junction coordinate, and clean highway placement.

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
  }
]
\`\`\`

Allowed types: "origin", "destination", "scenic_pull_off", "scenic_drive_by", "meal", "fuel", "lodging".

${contextBlock}
${conversationHistory}
Please respond to the latest User request.`;
}

/**
 * Builds the default Route Scout prompt.
 * Decorates the domain prompt with active adapter directives (defaults to agy).
 */
export function buildScoutPrompt(request: ScoutChatRequest, adapter?: AiHarnessAdapter): string {
  const domainPrompt = buildScoutDomainPrompt(request);
  if (adapter && typeof adapter.decorateScoutPrompt === 'function') {
    return adapter.decorateScoutPrompt(domainPrompt);
  }
  const agy = new AgyHarnessAdapter();
  return agy.decorateScoutPrompt ? agy.decorateScoutPrompt(domainPrompt) : domainPrompt;
}

/**
 * Cleans internal agent harness noise, background task text, and meta-commentary from Route Scout responses.
 * Delegates to AgyHarnessAdapter.sanitizeAgyResponse.
 */
export function sanitizeScoutReply(text: string): string {
  return AgyHarnessAdapter.sanitizeAgyResponse(text);
}

/**
 * Separates intermediate tool-calling or reasoning preambles from the final answer.
 */
export function separateThoughtAndReply(text: string): { thought?: string; reply: string } {
  const sanitized = sanitizeScoutReply(text);

  // Matches agent preambles (e.g. "I have launched a query...", "I will analyze...") before markdown heading or main body
  const multiLineRegex = /^((?:I (?:have launched|am checking|am inspecting|will analyze|will inspect|will check|have initiated|need to inspect)[^\n]+(?:\n+|$))+)\n*([\s\S]*)$/i;
  const match = sanitized.match(multiLineRegex);
  if (match && match[1] && match[2] && match[2].trim().length > 0) {
    return {
      thought: match[1].trim(),
      reply: sanitizeScoutReply(match[2]),
    };
  }

  const singlePreambleRegex = /^(?:I have launched a query[^.\n]*\.[^.\n]*\.\s*|I will analyze the results as soon as they return\.\s*|Let me inspect[^.\n]*\.\s*)/i;
  const singleMatch = sanitized.match(singlePreambleRegex);
  if (singleMatch && singleMatch[0]) {
    const thought = singleMatch[0].trim();
    const reply = sanitizeScoutReply(sanitized.slice(singleMatch[0].length));
    if (reply.length > 0) {
      return { thought, reply };
    }
  }

  return { reply: sanitized };
}

/**
 * Structurally verifies a Google Place ID against Google's binary protobuf specification:
 * - Starts with "ChIJ"
 * - Base64url encoded
 * - Decodes to exactly 20 bytes with tags: byte[0]=0x0a, byte[1]=0x12, byte[2]=0x09, byte[11]=0x11
 */
export function isValidGooglePlaceId(placeId: string): boolean {
  if (typeof placeId !== 'string') return false;
  const trimmed = placeId.trim();
  if (!/^ChIJ[A-Za-z0-9_-]{20,45}$/.test(trimmed)) {
    return false;
  }
  try {
    let b64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const buf = Buffer.from(b64, 'base64');
    if (buf.length !== 20) return false;
    return buf[0] === 0x0a && buf[1] === 0x12 && buf[2] === 0x09 && buf[11] === 0x11;
  } catch {
    return false;
  }
}

/**
 * Deterministically validates a Google Place ID returned by Route Scout or external AI.
 * Strips invalid or unverified place IDs.
 * Rules:
 * 1. If knownPlaceIds is provided and contains the ID, it is trusted immediately.
 * 2. Otherwise, newly returned Place IDs must pass the binary protobuf structural validation.
 * "No Place ID is always better than a wrong Place ID."
 */
export function validateScoutPlaceId(
  placeId: unknown,
  knownPlaceIds?: Set<string>
): string | undefined {
  if (typeof placeId !== 'string') return undefined;
  const trimmed = placeId.trim();
  if (!trimmed) return undefined;

  // 1. If in known verified IDs, accept directly
  if (knownPlaceIds && knownPlaceIds.has(trimmed)) {
    return trimmed;
  }

  // 2. Binary Protobuf structural validation
  if (!isValidGooglePlaceId(trimmed)) {
    return undefined;
  }

  return trimmed;
}

/**
 * Parses Route Scout output, extracting markdown conversation and structured suggestion actions.
 */
export function parseScoutResponse(
  rawOutput: string,
  options?: { knownPlaceIds?: Set<string> }
): { reply: string; suggestions: ScoutSuggestion[]; thought?: string } {
  if (!rawOutput) {
    return { reply: 'No response received from Route Scout.', suggestions: [] };
  }

  let reply = rawOutput.trim();
  const suggestions: ScoutSuggestion[] = [];

  // Match ```json:suggestions ... ``` or ```json ... ``` containing array with action field
  const blockRegex = /```(?:json:suggestions|json)?\s*(\[\s*\{[\s\S]*?\}\s*\])\s*```/i;
  const match = rawOutput.match(blockRegex);

  if (match && match[1]) {
    try {
      const parsedArray = JSON.parse(match[1]);
      if (Array.isArray(parsedArray)) {
        parsedArray.forEach((item, index) => {
          if (
            typeof item === 'object' &&
            item !== null &&
            (item.action === 'add_waypoint' || item.action === 'update_waypoint') &&
            typeof item.lat === 'number' &&
            typeof item.lng === 'number' &&
            !isNaN(item.lat) &&
            !isNaN(item.lng)
          ) {
            const newId =
              typeof item.newId === 'string' && item.newId.trim().length > 0
                ? item.newId.trim()
                : typeof item.new_id === 'string' && item.new_id.trim().length > 0
                ? item.new_id.trim()
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

            const rawIsAnchor =
              typeof item.is_route_anchor === 'boolean'
                ? item.is_route_anchor
                : typeof item.isRouteAnchor === 'boolean'
                ? item.isRouteAnchor
                : undefined;

            // Physical stops (lodging, meal, fuel, origin, destination, or dwell > 0) are NEVER pass-through anchors
            const isPhysical =
              item.type === 'lodging' ||
              item.type === 'meal' ||
              item.type === 'fuel' ||
              item.type === 'origin' ||
              item.type === 'destination' ||
              (typeof item.dwell_minutes === 'number' && item.dwell_minutes > 0);

            const is_route_anchor = isPhysical ? false : rawIsAnchor;

            suggestions.push({
              id: `scout_sug_${Date.now()}_${index}`,
              action: item.action,
              name: typeof item.name === 'string' ? item.name : 'Suggested Stop',
              place_name,
              type: typeof item.type === 'string' ? item.type : 'scenic_pull_off',
              lat: Number(item.lat.toFixed(6)),
              lng: Number(item.lng.toFixed(6)),
              dwell_minutes: typeof item.dwell_minutes === 'number' ? item.dwell_minutes : 15,
              trigger_radius_miles: typeof item.trigger_radius_miles === 'number' ? item.trigger_radius_miles : 2.0,
              reason: typeof item.reason === 'string' ? item.reason : 'Recommended by Route Scout',
              insertAfterWaypointId: typeof item.insertAfterWaypointId === 'string' ? item.insertAfterWaypointId : undefined,
              targetWaypointId: typeof item.targetWaypointId === 'string' ? item.targetWaypointId : undefined,
              newId,
              address:
                typeof item.address === 'string' && item.address.trim().length > 0
                  ? item.address.trim()
                  : undefined,
              google_place_id: validatedPlaceId,
              is_route_anchor,
              notification:
                typeof item.notification === 'object' && item.notification !== null
                  ? {
                      title: typeof item.notification.title === 'string' ? item.notification.title : '',
                      message: typeof item.notification.message === 'string' ? item.notification.message : '',
                      speech: typeof item.notification.speech === 'string' ? item.notification.speech : '',
                    }
                  : undefined,
            });
          }
        });
      }
      // Strip the code block from the user-facing text
      reply = rawOutput.replace(blockRegex, '').trim();
    } catch {
      // If parsing fails, preserve raw output
    }
  }

  const separated = separateThoughtAndReply(reply);
  return {
    reply: separated.reply,
    suggestions,
    thought: separated.thought,
  };
}

/**
 * Deterministic offline fallback when AI models are unavailable.
 */
export function generateTemplateScoutResponse(request: ScoutChatRequest): { reply: string; suggestions: ScoutSuggestion[] } {
  const { scope, messages, tripContext } = request;
  const lastMessage = messages[messages.length - 1]?.content.toLowerCase() || '';

  if (scope.type === 'waypoint') {
    const focused = tripContext.focusedWaypoint || tripContext.waypoints.find((w) => w.id === scope.waypointId);
    const name = focused?.name || 'this waypoint';
    const type = focused?.type || 'scenic_pull_off';
    const dwell = focused?.dwell_minutes ?? 0;
    const hasAddress = !!(focused?.address || focused?.google_place_id);

    // 1. Google Maps navigation / address audit
    if (
      lastMessage.includes('google maps') ||
      lastMessage.includes('address') ||
      lastMessage.includes('entrance') ||
      lastMessage.includes('place id')
    ) {
      if (!hasAddress && (type === 'lodging' || type === 'meal' || type === 'fuel' || dwell > 0)) {
        return {
          reply: `### Google Maps Navigation Audit: ${name}\n\nThis physical stop (${type}) currently relies solely on raw latitude/longitude coordinates without a verified street address or Google Place ID.\n\nIn consumer Google Maps and Android Auto, raw coordinates for commercial venues or lodging can cause navigation to snap to rear service alleys, loading docks, or neighboring parcels. Providing a verified street address or Google Place ID ensures the in-car navigation routes directly to the main guest entrance or parking facility.`,
          suggestions: [
            {
              id: `scout_fallback_addr_${Date.now()}`,
              action: 'update_waypoint',
              targetWaypointId: focused?.id || 'wp_focus',
              name,
              type,
              lat: focused?.lat ?? 0,
              lng: focused?.lng ?? 0,
              dwell_minutes: dwell,
              trigger_radius_miles: focused?.trigger_radius_miles ?? 2.0,
              address: `${name}, Main Entrance`,
              reason: 'Adds street address hint to ensure accurate Google Maps entrance routing.',
            },
          ],
        };
      }

      return {
        reply: `### Google Maps Navigation: ${name}\n\n- **Category:** ${type}\n- **Address / Place:** ${focused?.address || 'Using verified coordinates'}\n- **Route Anchor:** ${focused?.is_route_anchor ? 'Yes (locks highway corridor in Google Maps)' : 'No (commentary or destination stop)'}\n\nThis waypoint is configured for navigation. If adjusting its alignment, ensure the coordinate sits at the road entrance rather than a pedestrian trail or back alley.`,
        suggestions: [],
      };
    }

    // 2. Alert copy / ID synchronization mismatch check
    const hasFuelInText =
      (focused?.id.toLowerCase().includes('fuel') ?? false) ||
      (focused?.notification?.speech?.toLowerCase().includes('fuel') ?? false) ||
      (focused?.notification?.title?.toLowerCase().includes('fuel') ?? false);
    const isFuelType = type === 'fuel';

    if (
      (!isFuelType && hasFuelInText) ||
      lastMessage.includes('mismatch') ||
      lastMessage.includes('alert') ||
      lastMessage.includes('speech') ||
      lastMessage.includes('sync')
    ) {
      if (!isFuelType && hasFuelInText) {
        const cleanId = (focused?.id || 'waypoint').replace(/_fuel/g, `_${type}`);
        return {
          reply: `### Waypoint Copy & ID Synchronization: ${name}\n\nUpon auditing **${name}**, there is a mismatch between the current stop category (**${type}**) and its saved properties:\n\n- **Waypoint ID:** The ID is currently \`${focused?.id}\`, which references a fuel stop.\n- **Heads-Up Alert & Voice:** The alert or speech copy mentions fuel, which conflicts with this **${type}** stop.\n\nI have generated an update card below to synchronize the ID and refresh the heads-up notification and voice copy.`,
          suggestions: [
            {
              id: `scout_fallback_sync_${Date.now()}`,
              action: 'update_waypoint',
              targetWaypointId: focused?.id || 'wp_sync',
              newId: cleanId,
              name,
              type,
              lat: focused?.lat ?? 0,
              lng: focused?.lng ?? 0,
              dwell_minutes: dwell,
              trigger_radius_miles: focused?.trigger_radius_miles ?? 2.0,
              reason: `Synchronizes waypoint ID and notification copy with the ${type} category.`,
              notification: {
                title: name.slice(0, 30),
                message: `Arriving at ${name}. Recommended ${dwell > 0 ? `${dwell}-minute ` : ''}stop.`,
                speech: `Arriving at ${name}. ${dwell > 0 ? `Recommended ${dwell} minute stop.` : 'Enjoy the scenery.'}`,
              },
            },
          ],
        };
      }
    }

    // 3. Drive-by dwell time check
    if (type === 'scenic_drive_by' && dwell > 0) {
      return {
        reply: `### In-Transit Drive-By Configuration: ${name}\n\nThis waypoint is marked as a **scenic drive-by**, but has a scheduled dwell time of **${dwell} minutes**.\n\nIn-transit drive-by waypoints exist purely to trigger in-car spoken announcements as you drive past at highway speed. A non-zero dwell time causes the schedule cascade to allocate stopping time on the shoulder. Setting dwell to **0 minutes** keeps your timeline accurate.`,
        suggestions: [
          {
            id: `scout_fallback_dwell_${Date.now()}`,
            action: 'update_waypoint',
            targetWaypointId: focused?.id || 'wp_dwell',
            name,
            type: 'scenic_drive_by',
            lat: focused?.lat ?? 0,
            lng: focused?.lng ?? 0,
            dwell_minutes: 0,
            trigger_radius_miles: focused?.trigger_radius_miles ?? 2.0,
            reason: 'Resets in-transit drive-by dwell to 0 minutes for audio-only highway trigger.',
          },
        ],
      };
    }

    // 4. Accessibility & parking
    if (lastMessage.includes('park') || lastMessage.includes('access') || lastMessage.includes('road')) {
      return {
        reply: `### Waypoint Accessibility: ${name}\n\n- **Category:** ${type}\n- **Coordinates:** \`${(focused?.lat ?? 0).toFixed(4)}, ${(focused?.lng ?? 0).toFixed(4)}\`\n- **Dwell Time:** ${dwell} minutes\n\nFor highway pull-offs and commercial stops, ensure the pin is located on paved road access or authorized parking aprons rather than on hiking trails or dirt service tracks.`,
        suggestions: [],
      };
    }

    // 5. Default generic waypoint overview
    return {
      reply: `### Route Scout Audit: ${name}\n\n- **Category:** ${type}\n- **Target Arrival:** ${focused?.target_time || 'Dynamic schedule'}\n- **Dwell:** ${dwell} minutes\n- **Trigger Distance:** ${focused?.trigger_radius_miles ?? 2.0} miles\n${focused?.address ? `- **Address:** ${focused.address}\n` : ''}${focused?.is_route_anchor ? '- **Route Anchor:** Yes (forces scenic highway routing)\n' : ''}\nThis waypoint is positioned on your active driving leg. To adjust alert parameters, use the **Edit Alert & Voice** button in the timeline.`,
      suggestions: [],
    };
  }

  // Day Scope
  const origin = tripContext.origin || 'Start';
  const dest = tripContext.destination || 'End';

  // Audit / coordinate verification / off-highway detours / fuel stop checks / copy sync / google maps
  if (
    lastMessage.includes('audit') ||
    lastMessage.includes('google maps') ||
    lastMessage.includes('navigation') ||
    lastMessage.includes('highway') ||
    lastMessage.includes('detour') ||
    lastMessage.includes('fuel') ||
    lastMessage.includes('mismatch') ||
    lastMessage.includes('alert') ||
    lastMessage.includes('voice') ||
    lastMessage.includes('rule') ||
    lastMessage.includes('fix')
  ) {
    const auditSuggestions: ScoutSuggestion[] = [];
    const auditNotes: string[] = [];

    tripContext.waypoints.forEach((w) => {
      const dwell = w.dwell_minutes ?? 0;

      // Check 1: Category vs notification copy / ID mismatch
      const hasFuelText =
        w.id.toLowerCase().includes('fuel') ||
        (w.notification?.speech?.toLowerCase().includes('fuel') ?? false) ||
        (w.notification?.title?.toLowerCase().includes('fuel') ?? false);
      if (w.type !== 'fuel' && hasFuelText) {
        const cleanId = w.id.replace(/_fuel/g, `_${w.type}`);
        auditSuggestions.push({
          id: `scout_audit_sync_${w.id}_${Date.now()}`,
          action: 'update_waypoint',
          targetWaypointId: w.id,
          newId: cleanId,
          name: w.name,
          type: w.type,
          lat: w.lat,
          lng: w.lng,
          dwell_minutes: dwell,
          trigger_radius_miles: w.trigger_radius_miles,
          reason: `Synchronizes waypoint ID and replaces obsolete fuel alert copy with text matching ${w.type} category.`,
          notification: {
            title: w.name.slice(0, 30),
            message: `Arriving at ${w.name}. Recommended ${dwell > 0 ? `${dwell}-min ` : ''}stop.`,
            speech: `Arriving at ${w.name}. ${dwell > 0 ? `Recommended ${dwell} minute break.` : 'Enjoy the view.'}`,
          },
        });
        auditNotes.push(`**${w.name}**: Synchronized waypoint ID and updated notification copy to remove outdated fuel references.`);
      }

      // Check 2: Scenic drive-by with non-zero dwell
      if (w.type === 'scenic_drive_by' && dwell > 0) {
        auditSuggestions.push({
          id: `scout_audit_dwell_${w.id}_${Date.now()}`,
          action: 'update_waypoint',
          targetWaypointId: w.id,
          name: w.name,
          type: 'scenic_drive_by',
          lat: w.lat,
          lng: w.lng,
          dwell_minutes: 0,
          trigger_radius_miles: w.trigger_radius_miles,
          reason: 'Resets in-transit drive-by dwell time to 0 minutes for audio-only highway announcement.',
        });
        auditNotes.push(`**${w.name}**: Reset in-transit scenic drive-by dwell from ${dwell}m to 0m.`);
      }

      // Check 3: Physical stops missing street address / Place ID
      if (
        (w.type === 'lodging' || w.type === 'meal' || (w.type === 'fuel' && !w.address)) &&
        !w.address &&
        !w.google_place_id
      ) {
        auditSuggestions.push({
          id: `scout_audit_nav_${w.id}_${Date.now()}`,
          action: 'update_waypoint',
          targetWaypointId: w.id,
          name: w.name,
          type: w.type,
          lat: w.lat,
          lng: w.lng,
          dwell_minutes: dwell,
          trigger_radius_miles: w.trigger_radius_miles,
          address: `${w.name}`,
          reason: 'Adds entity name as address query to prevent Google Maps from snapping to back alleys or adjacent lots.',
        });
        auditNotes.push(`**${w.name}**: Configured entity name address query to ensure precise Google Maps entrance navigation.`);
      }
    });

    if (auditSuggestions.length > 0) {
      return {
        reply: `### Route Audit & Navigation Report\n\nI have reviewed the waypoints along the **${origin} → ${dest}** corridor. Here are the issues identified and corrected:\n\n${auditNotes.map((n) => `- ${n}`).join('\n')}\n\nYou can click **Preview** on each card below or **Update** to apply the fixes directly to your timeline.`,
        suggestions: auditSuggestions,
      };
    }

    return {
      reply: `### Route Audit & Navigation Report\n\nI have audited the ${tripContext.waypoints.length} waypoints along the **${origin} → ${dest}** corridor:\n\n- **Google Maps Navigation:** Physical stops have valid target locations, and in-transit triggers are configured for highway travel.\n- **Highway Alignment:** All scenic drive-by waypoints have 0m dwell for seamless audio announcements without off-highway detours.\n- **Notification Synchronization:** Waypoint IDs, heads-up cards, and voice audio match their assigned categories.\n\nYour route is clean and ready for navigation.`,
      suggestions: [],
    };
  }

  if (lastMessage.includes('lunch') || lastMessage.includes('food') || lastMessage.includes('eat') || lastMessage.includes('dine')) {
    const midwayLat = tripContext.waypoints.length > 0 ? (tripContext.waypoints[0].lat + tripContext.waypoints[tripContext.waypoints.length - 1].lat) / 2 : 35.0;
    const midwayLng = tripContext.waypoints.length > 0 ? (tripContext.waypoints[0].lng + tripContext.waypoints[tripContext.waypoints.length - 1].lng) / 2 : -110.0;

    return {
      reply: `### Mid-Route Dining Recommendations\n\nAlong the drive from **${origin}** to **${dest}**, timing lunch approximately halfway into your drive keeps driver fatigue low. Consider established highway trading posts or downtown plazas for reliable dining and clean restrooms.`,
      suggestions: [
        {
          id: `scout_fallback_lunch_${Date.now()}`,
          action: 'add_waypoint',
          name: 'Recommended Corridor Lunch Stop',
          type: 'meal',
          lat: Number(midwayLat.toFixed(4)),
          lng: Number(midwayLng.toFixed(4)),
          dwell_minutes: 45,
          trigger_radius_miles: 2.0,
          reason: 'Midway meal break recommendation along the planned travel route.',
        },
      ],
    };
  }

  return {
    reply: `### Day ${scope.dayNumber ?? 1} Route Scout Overview\n\n- **Leg:** ${origin} → ${dest}\n- **Current stops:** ${tripContext.waypoints.length}\n- **Departure:** ${tripContext.departureTime || '09:00 AM'}\n\nYou can ask Route Scout to investigate specific viewpoints, find fuel and meal stops, or inspect any waypoint's road access.`,
    suggestions: [],
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

/**
 * Route Scout Service Coordinator.
 */
export class ScoutService {
  private aiService: AiService;

  constructor(aiService?: AiService) {
    this.aiService = aiService || new AiService();
  }

  /**
   * Executes a multi-turn chat interaction with Route Scout.
   */
  async chat(request: ScoutChatRequest, options: GenerationOptions = {}): Promise<ScoutChatResponse> {
    const sessionId = request.sessionId || `scout_${Date.now()}`;
    const preferredEngine = options.preferredEngine || 'auto';

    if (preferredEngine === 'template') {
      const { reply, suggestions } = generateTemplateScoutResponse(request);
      return { reply, suggestions, sessionId, engine: 'template' };
    }

    const domainPrompt = buildScoutDomainPrompt(request);
    let lastError: string | null = null;

    const knownPlaceIds = new Set<string>(
      (request.tripContext?.waypoints || [])
        .map((w) => w.google_place_id)
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    );

    // 1. Try Primary: agy adapter
    if (preferredEngine !== 'cloud') {
      const agy = this.aiService.getAdapter('agy');
      if (agy) {
        try {
          const prompt = agy.decorateScoutPrompt ? agy.decorateScoutPrompt(domainPrompt) : domainPrompt;
          const rawOutput = await agy.generate(prompt);
          const sanitized = agy.sanitizeResponse ? agy.sanitizeResponse(rawOutput) : rawOutput;
          const { reply, suggestions, thought } = parseScoutResponse(sanitized, { knownPlaceIds });
          return { reply, suggestions, sessionId, engine: 'agy', thought };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          lastError = msg;
          console.warn(`[RouteScout] agy adapter generation failed (${msg})`);
        }
      }
    }

    // 2. Try Cloud Gemini API
    const cloud = this.aiService.getAdapter('cloud');
    if (cloud) {
      try {
        const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
        if (apiKey && (await cloud.isAvailable(apiKey))) {
          const prompt = cloud.decorateScoutPrompt ? cloud.decorateScoutPrompt(domainPrompt) : domainPrompt;
          const rawOutput = await cloud.generate(prompt, apiKey);
          const sanitized = cloud.sanitizeResponse ? cloud.sanitizeResponse(rawOutput) : rawOutput;
          const { reply, suggestions, thought } = parseScoutResponse(sanitized, { knownPlaceIds });
          return { reply, suggestions, sessionId, engine: 'cloud', thought };
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = msg;
        console.warn(`[RouteScout] cloud adapter generation failed (${msg})`);
      }
    }

    throw new Error(
      lastError?.includes('timed out')
        ? 'Route Scout timed out while analyzing your request. Please click Retry.'
        : `Route Scout error: ${lastError || 'unable to connect to an AI engine. Please verify your AI engine configuration or API key.'}`
    );
  }

  /**
   * Executes a streaming multi-turn chat interaction with Route Scout over SSE.
   */
  async chatStream(
    request: ScoutChatRequest,
    onEvent: (event: ScoutStreamEvent) => void,
    options: GenerationOptions = {}
  ): Promise<ScoutChatResponse> {
    const sessionId = request.sessionId || `scout_${Date.now()}`;
    const preferredEngine = options.preferredEngine || 'auto';

    if (preferredEngine === 'template') {
      const { reply, suggestions } = generateTemplateScoutResponse(request);
      onEvent({ event: 'delta', data: { text: reply } });
      if (suggestions.length > 0) {
        onEvent({ event: 'suggestions', data: { suggestions } });
      }
      const doneResponse: ScoutChatResponse = { reply, suggestions, sessionId, engine: 'template' };
      onEvent({ event: 'done', data: doneResponse });
      return doneResponse;
    }

    const domainPrompt = buildScoutDomainPrompt(request);
    let lastError: string | null = null;

    const knownPlaceIds = new Set<string>(
      (request.tripContext?.waypoints || [])
        .map((w) => w.google_place_id)
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    );

    // 1. Try Primary: agy adapter streaming
    if (preferredEngine !== 'cloud') {
      const agy = this.aiService.getAdapter('agy') as (AgyHarnessAdapter | undefined);
      if (agy && typeof agy.generateStream === 'function') {
        try {
          const prompt = agy.decorateScoutPrompt ? agy.decorateScoutPrompt(domainPrompt) : domainPrompt;
          const activities: ScoutActivity[] = [];
          const rawOutput = await agy.generateStream(prompt, (chunk) => {
            if (chunk.type === 'activity' && chunk.activity) {
              const existingIdx = activities.findIndex((a) => a.id === chunk.activity!.id);
              if (existingIdx >= 0) {
                activities[existingIdx] = chunk.activity;
              } else {
                activities.push(chunk.activity);
              }
              onEvent({ event: 'activity', data: chunk.activity });
            } else if (chunk.type === 'thought') {
              onEvent({ event: 'thought', data: { text: chunk.text } });
            } else if (chunk.type === 'delta') {
              onEvent({ event: 'delta', data: { text: chunk.text } });
            }
          });

          const sanitized = agy.sanitizeResponse ? agy.sanitizeResponse(rawOutput) : rawOutput;
          const { reply, suggestions, thought } = parseScoutResponse(sanitized, { knownPlaceIds });
          if (suggestions.length > 0) {
            onEvent({ event: 'suggestions', data: { suggestions } });
          }
          const doneResponse: ScoutChatResponse = {
            reply,
            suggestions,
            sessionId,
            engine: 'agy',
            thought,
            activities: activities.length > 0 ? activities : undefined,
          };
          onEvent({ event: 'done', data: doneResponse });
          return doneResponse;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          lastError = msg;
          console.warn(`[RouteScout] agy adapter streaming failed (${msg})`);
        }
      }
    }

    // 2. Try Cloud Gemini API
    const cloud = this.aiService.getAdapter('cloud');
    const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
    if (cloud && apiKey) {
      try {
        const prompt = cloud.decorateScoutPrompt ? cloud.decorateScoutPrompt(domainPrompt) : domainPrompt;
        const rawOutput = await cloud.generate(prompt, apiKey);
        const sanitized = cloud.sanitizeResponse ? cloud.sanitizeResponse(rawOutput) : rawOutput;
        const { reply, suggestions, thought } = parseScoutResponse(sanitized, { knownPlaceIds });
        onEvent({ event: 'delta', data: { text: reply } });
        if (suggestions.length > 0) {
          onEvent({ event: 'suggestions', data: { suggestions } });
        }
        const doneResponse: ScoutChatResponse = { reply, suggestions, sessionId, engine: 'cloud', thought };
        onEvent({ event: 'done', data: doneResponse });
        return doneResponse;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = msg;
        console.warn(`[RouteScout] cloud adapter fallback failed (${msg})`);
      }
    }

    // Friendly error handling
    const friendlyError = lastError?.includes('timed out')
      ? 'Route Scout timed out while analyzing your request. Please click Retry.'
      : `Route Scout error: ${lastError || 'unable to generate a response. Please retry.'}`;

    onEvent({ event: 'error', data: { error: friendlyError } });
    throw new Error(friendlyError);
  }

  /**
   * Returns contextual quick prompts for a scope.
   */
  getQuickPrompts(scope: ScoutScope): string[] {
    return getQuickPrompts(scope);
  }
}
