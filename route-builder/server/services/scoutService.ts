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
      contextBlock += `- ID: ${focused.id}\n`;
      contextBlock += `- Name: ${focused.name}\n`;
      contextBlock += `- Category Type: ${focused.type}\n`;
      contextBlock += `- GPS Coordinates: ${focused.lat.toFixed(6)}, ${focused.lng.toFixed(6)}\n`;
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
8. WAYPOINTS MUST BE GOOGLE MAPS COMPATIBLE LOCATIONS:
   - Waypoints should be real, recognizable places (venues, official scenic overlooks, or highway mileposts that Google Maps can navigate to without breaking the route).
   - If coordinates are specified, they must be verified so that routing stays clean, continuous, and on-highway.
9. ROUTE AUDITING & REPAIR:
   - When the driver asks to audit the route or fix coordinates (e.g. "some waypoints take me off the highway", "the fuel stop is in a trailer park", or "fix drive-by points"), inspect all waypoints on the active day or focused stop.
   - Identify which waypoints depart from the highway or point to wrong locations, explain the error clearly to the driver, and emit concrete "update_waypoint" suggestion cards with the exact, verified highway coordinates and corrected names/dwells so the driver can apply the fixes with 1 click.
10. SYNCHRONIZE WAYPOINT ID, HEADS-UP NOTIFICATION & VOICE ALERT COPY:
   - When suggesting an "update_waypoint" or "add_waypoint", ALWAYS include an updated "notification" object containing:
     * "title": Short heads-up card title (<= 30 chars), formatted concisely (e.g. "Red Rock Park Picnic").
     * "message": In-car heads-up text (<= 2 lines), describing the upcoming stop, target time, and immediate highway direction.
     * "speech": Natural conversational spoken TTS audio script (15-25 words, ~10s speech duration).
   - CRITICAL NOTIFICATION CONSISTENCY:
     * If a waypoint's purpose, category, or name changes (for example, if what was originally a fuel stop is changed to a lunch stop at a park, or a scenic pull-off is changed to a meal break), the alert "title", "message", and "speech" MUST be completely rewritten to match the new purpose!
     * NEVER retain obsolete notification copy or audio scripts from the previous purpose (e.g. if a stop is now a picnic park or diner, the notification and spoken audio MUST NOT say "Fuel stop recommended" or refer to gas pumps).
   - WAYPOINT ID SYNCHRONIZATION:
     * If a waypoint's current ID reflects an obsolete purpose or old location (e.g. an ID of "gallup_fuel" for a stop that is now "Red Rock Park (Picnic & Stretch)"), specify "newId" (e.g. "gallup_red_rock_park" or "red_rock_park", in lowercase alphanumeric snake_case) so the underlying waypoint ID stays synchronized.
   - AUDITING ID & NOTIFICATION MISMATCHES:
     * When auditing waypoints, actively check whether a waypoint's ID or notification text conflicts with its name or category (e.g. an ID containing "fuel" when the category is "meal", or spoken audio announcing a fuel stop when arriving at a state park or diner).
     * Flag these contradictions clearly to the driver and emit an "update_waypoint" card with the corrected "newId" and updated "notification" copy to resolve the discrepancy.

JSON SUGGESTIONS BLOCK FORMAT (Append at the end if making concrete recommendations):
\`\`\`json:suggestions
[
  {
    "action": "add_waypoint",
    "name": "Stop Name",
    "type": "scenic_pull_off",
    "lat": 35.1234,
    "lng": -111.5678,
    "dwell_minutes": 20,
    "trigger_radius_miles": 2.0,
    "insertAfterWaypointId": "optional_preceding_waypoint_id",
    "reason": "Clear explanation of why this stop is recommended.",
    "notification": {
      "title": "Short Title (<=30 chars)",
      "message": "Heads-up alert text (<=2 lines)",
      "speech": "Natural conversational spoken TTS audio (15-25 words, ~10s)"
    }
  },
  {
    "action": "update_waypoint",
    "targetWaypointId": "target_id",
    "newId": "updated_id_snake_case",
    "name": "Updated Name",
    "type": "meal",
    "lat": 35.5678,
    "lng": -111.1234,
    "dwell_minutes": 30,
    "trigger_radius_miles": 3.0,
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
 * Parses Route Scout output, extracting markdown conversation and structured suggestion actions.
 */
export function parseScoutResponse(rawOutput: string): { reply: string; suggestions: ScoutSuggestion[]; thought?: string } {
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

            suggestions.push({
              id: `scout_sug_${Date.now()}_${index}`,
              action: item.action,
              name: typeof item.name === 'string' ? item.name : 'Suggested Stop',
              type: typeof item.type === 'string' ? item.type : 'scenic_pull_off',
              lat: Number(item.lat.toFixed(6)),
              lng: Number(item.lng.toFixed(6)),
              dwell_minutes: typeof item.dwell_minutes === 'number' ? item.dwell_minutes : 15,
              trigger_radius_miles: typeof item.trigger_radius_miles === 'number' ? item.trigger_radius_miles : 2.0,
              reason: typeof item.reason === 'string' ? item.reason : 'Recommended by Route Scout',
              insertAfterWaypointId: typeof item.insertAfterWaypointId === 'string' ? item.insertAfterWaypointId : undefined,
              targetWaypointId: typeof item.targetWaypointId === 'string' ? item.targetWaypointId : undefined,
              newId,
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

    // 1. Red Rock Park / Gallup ID and notification mismatch check
    if (
      focused?.id === 'gallup_fuel' ||
      (focused &&
        focused.name.toLowerCase().includes('red rock') &&
        (focused.id.toLowerCase().includes('fuel') ||
          (focused.notification && focused.notification.speech.toLowerCase().includes('fuel')))) ||
      (focused?.type === 'meal' &&
        (focused.id.includes('fuel') ||
          (focused.notification && focused.notification.speech.toLowerCase().includes('fuel')))) ||
      lastMessage.includes('red rock') ||
      (lastMessage.includes('gallup') && (lastMessage.includes('park') || lastMessage.includes('picnic') || lastMessage.includes('lunch')))
    ) {
      return {
        reply: `### Waypoint Copy & ID Synchronization: ${name}\n\nUpon auditing **${name}**, there is a mismatch between the current stop purpose and its saved properties:\n\n- **Waypoint ID:** The ID is currently \`${focused?.id}\`, still referencing an obsolete fuel stop.\n- **Heads-Up Alert & Voice:** The alert title is currently *"${focused?.notification?.title || ''}"* and the spoken audio announces a *fuel stop*, even though this stop has been designated as a **${focused?.type || 'meal'}** stop at Red Rock Park.\n\nI have generated an update card below to synchronize the ID to \`gallup_red_rock_park\` and replace the notification text and voice alert with clean audio describing your 30-minute picnic break and scenic stretch before turning north on US-491.`,
        suggestions: [
          {
            id: `scout_fallback_gallup_${Date.now()}`,
            action: 'update_waypoint',
            targetWaypointId: focused?.id || 'gallup_fuel',
            newId: 'gallup_red_rock_park',
            name: 'Red Rock Park (Picnic & Stretch)',
            type: 'meal',
            lat: focused?.lat ?? 35.5458,
            lng: focused?.lng ?? -108.6255,
            dwell_minutes: 30,
            trigger_radius_miles: 3.0,
            reason: "Synchronizes waypoint ID to 'gallup_red_rock_park' and replaces outdated fuel alert text with updated picnic, lunch, and red rock park audio.",
            notification: {
              title: 'Red Rock Park Picnic & Stretch',
              message: 'Target 11:30 AM MDT. 30-min picnic break & stretch among red rock cliffs before US-491.',
              speech: 'Arriving at Red Rock Park outside Gallup. Note the one-hour time change to Mountain Daylight Time. Recommended thirty-minute picnic break and stretch before heading north on Highway 491.',
            },
          },
        ],
      };
    }

    // 2. Fuel stop verification / commercial amenities audit
    if (
      focused?.type === 'fuel' ||
      focused?.name.toLowerCase().includes('maverik') ||
      lastMessage.includes('fuel') ||
      lastMessage.includes('gas') ||
      lastMessage.includes('trailer') ||
      lastMessage.includes('restroom') ||
      lastMessage.includes('pump')
    ) {
      if (
        focused?.id === 'wp_1789354019621_9s3w' ||
        (focused && focused.lat > 36.70 && focused.lat < 36.76 && focused.lng > -108.30 && focused.lng < -108.20)
      ) {
        return {
          reply: `### Commercial Fuel Stop Audit: ${name}\n\nUpon auditing the coordinates for **${name}**, the current pin (\`36.7465, -108.2675\`) sits in a residential mobile home park on Finch Ave off North Dustin, lacking commercial fuel bays or traveler amenities.\n\nThe genuine **Maverik Adventure's First Stop** in Farmington is located at **2710 W Main St** directly on the **US-64** commercial corridor (\`36.7328, -108.2443\`). It offers 16 high-flow fuel bays, clean public restrooms, hot prepared food, and easy highway re-entry with zero residential detours.`,
          suggestions: [
            {
              id: `scout_fallback_maverik_${Date.now()}`,
              action: 'update_waypoint',
              targetWaypointId: focused?.id || 'wp_1789354019621_9s3w',
              newId: 'maverik_farmington',
              name: "Maverik Adventure's First Stop (Farmington)",
              type: 'fuel',
              lat: 36.7328,
              lng: -108.2443,
              dwell_minutes: 15,
              trigger_radius_miles: 1.5,
              reason: 'Relocated from residential mobile home park to the authentic Maverik commercial station at 2710 W Main St on US-64 with fuel pumps and clean restrooms.',
              notification: {
                title: 'Maverik Fuel & Food Stop',
                message: '2710 W Main St on US-64. Fuel pumps, clean restrooms, and refreshments.',
                speech: 'Approaching Maverik Adventure Stop on West Main Street. Recommended 15 minute fuel and rest break before heading into the mountains.',
              },
            },
          ],
        };
      }
    }

    // 3. Highway alignment / coordinate audit for drive-by waypoints
    if (
      lastMessage.includes('coord') ||
      lastMessage.includes('wrong') ||
      lastMessage.includes('fix') ||
      lastMessage.includes('shift') ||
      lastMessage.includes('highway') ||
      lastMessage.includes('drive by') ||
      lastMessage.includes('drive-by') ||
      lastMessage.includes('detour')
    ) {
      if (focused?.id === 'painted_desert_view' || focused?.name.toLowerCase().includes('painted desert')) {
        return {
          reply: `### Highway Alignment Audit: ${name}\n\nThe previous coordinate (\`34.9810, -110.0545\`) was placed south of Interstate 40 on unpaved Goodwater Rd / Quartzsite St, which forces navigation engines to route you off the freeway onto dirt tracks. For a drive-by waypoint with 0-minute dwell, the coordinate must remain directly on the **I-40 East** centerline (\`34.9809, -110.0525\`) to fire the audio announcement seamlessly without leaving the highway.`,
          suggestions: [
            {
              id: `scout_fallback_pd_${Date.now()}`,
              action: 'update_waypoint',
              targetWaypointId: focused.id,
              name: 'Painted Desert Badlands',
              type: 'scenic_pull_off',
              lat: 34.9809,
              lng: -110.0525,
              dwell_minutes: 0,
              trigger_radius_miles: 4.0,
              reason: 'Snaps coordinate to I-40 East centerline to eliminate the off-highway dirt road detour.',
              notification: {
                title: 'Painted Desert Scenery',
                message: 'Look north of I-40 near Holbrook for vivid badlands views.',
                speech: 'Scenic alert: Passing the Painted Desert badlands to the north of Interstate 40.',
              },
            },
          ],
        };
      }

      if (focused?.id === 'shiprock_peak' || focused?.name.toLowerCase().includes('shiprock')) {
        return {
          reply: `### Highway Alignment Audit: ${name}\n\nThe previous coordinate (\`36.6872, -108.6875\`) sat over a mile east into desert scrub on sacred Navajo tribal land, forcing an unpaved 2.3-mile off-road detour. For a drive-by waypoint with 0-minute dwell, the coordinate should be positioned on **US-491 North** (\`36.6878, -108.7078\`) directly abreast of the peak, triggering the in-car heads-up card and spoken overview without leaving the paved highway.`,
          suggestions: [
            {
              id: `scout_fallback_sr_${Date.now()}`,
              action: 'update_waypoint',
              targetWaypointId: focused.id,
              name: 'Shiprock Peak (US-491)',
              type: 'scenic_pull_off',
              lat: 36.6878,
              lng: -108.7078,
              dwell_minutes: 0,
              trigger_radius_miles: 6.0,
              reason: 'Aligns pin with US-491 North abreast of the peak, eliminating the off-road detour onto tribal land.',
              notification: {
                title: 'Shiprock Landmark Ahead',
                message: '1,583-ft volcanic peak visible for miles. View from highway only (sacred tribal land).',
                speech: 'Upcoming sight on your left: Shiprock Peak, rising fifteen hundred feet from the desert floor. Highway viewing only as this is sacred Navajo land.',
              },
            },
          ],
        };
      }

      if (focused?.id === 'dulce_foothills' || focused?.name.toLowerCase().includes('dulce')) {
        return {
          reply: `### Highway Alignment Audit: ${name}\n\nThe previous coordinate (\`36.9325, -106.9998\`) drifted 1.5 miles north into residential Apache Dr. To keep in-transit audio triggers clean without leaving the highway, the coordinate is snapped to **US-64 East** (\`36.9107, -106.9996\`).`,
          suggestions: [
            {
              id: `scout_fallback_dulce_${Date.now()}`,
              action: 'update_waypoint',
              targetWaypointId: focused.id,
              name: 'Jicarilla Apache Nation / Dulce',
              type: 'scenic_pull_off',
              lat: 36.9107,
              lng: -106.9996,
              dwell_minutes: 0,
              trigger_radius_miles: 3.0,
              reason: 'Snaps coordinate to US-64 East highway corridor, eliminating residential side-street detour.',
              notification: {
                title: 'Climbing into Pine & Aspen Country',
                message: 'US-64 climbing toward Chama. Early autumn foliage.',
                speech: 'Climbing through the Jicarilla Apache Nation on US-64. Watch for early autumn aspen color as we enter the foothills.',
              },
            },
          ],
        };
      }

      if (focused?.id === 'chama_arrival' || focused?.name.toLowerCase().includes('chama')) {
        return {
          reply: `### Arrival Location Audit: ${name}\n\nUpdating destination coordinate to the verified location of **Vista Del Rio Lodge** at 2595 US-64 in Chama (\`36.8748, -106.5835\`).`,
          suggestions: [
            {
              id: `scout_fallback_chama_${Date.now()}`,
              action: 'update_waypoint',
              targetWaypointId: focused.id,
              name: 'Chama / Vista Del Rio Lodge',
              type: 'lodging',
              lat: 36.8748,
              lng: -106.5835,
              dwell_minutes: 0,
              trigger_radius_miles: 1.0,
              reason: 'Positions arrival at the genuine lodge property on US-64 in Chama.',
              notification: {
                title: 'Arrival in Chama',
                message: 'Target 5:00-5:30 PM. Check-in at Vista Del Rio Lodge. Dinner at Local.',
                speech: 'Welcome to Chama. Vista Del Rio Lodge is on the right. Dinner tonight is at Local on Terrace Avenue.',
              },
            },
          ],
        };
      }

      return {
        reply: `### Coordinate Verification: ${name}\n\nWhen verifying a waypoint along a highway corridor, ensure the pin is placed directly on the paved roadway or an authorized pull-off rather than on backcountry dirt tracks. You can drag the marker directly on the map canvas or use the search bar to lock to a street address.`,
        suggestions: [],
      };
    }

    if (lastMessage.includes('park') || lastMessage.includes('access') || lastMessage.includes('road')) {
      return {
        reply: `### Waypoint Accessibility: ${name}\n\nBased on regional road attributes, highway pull-offs typically have designated paved shoulders or roadside gravel aprons. If traveling with a standard passenger car or rental SUV, exercise caution with unpaved road shoulders after rain.\n\nYou can click **Preview on Map** to zoom in and check satellite imagery against the road alignment.`,
        suggestions: [],
      };
    }

    return {
      reply: `### Route Scout Audit: ${name}\n\n- **Target Arrival:** ${focused?.target_time || 'Dynamic schedule'}\n- **Dwell:** ${focused?.dwell_minutes ?? 15} minutes\n- **Trigger Distance:** ${focused?.trigger_radius_miles ?? 2.0} miles\n\nThis waypoint is positioned on your active driving leg. To adjust alert parameters, use the **Edit Alert & Voice** button in the timeline.`,
      suggestions: [],
    };
  }

  // Day Scope
  const origin = tripContext.origin || 'Start';
  const dest = tripContext.destination || 'End';

  // Audit / coordinate verification / off-highway detours / fuel stop checks / copy sync
  if (
    lastMessage.includes('audit') ||
    lastMessage.includes('highway') ||
    lastMessage.includes('off the highway') ||
    lastMessage.includes('fuel') ||
    lastMessage.includes('gas') ||
    lastMessage.includes('trailer') ||
    lastMessage.includes('broken') ||
    lastMessage.includes('coord') ||
    lastMessage.includes('detour') ||
    lastMessage.includes('drive by') ||
    lastMessage.includes('drive-by') ||
    lastMessage.includes('wrong') ||
    lastMessage.includes('rule') ||
    lastMessage.includes('fix') ||
    lastMessage.includes('alert') ||
    lastMessage.includes('voice') ||
    lastMessage.includes('mismatch')
  ) {
    const auditSuggestions: ScoutSuggestion[] = [];
    const auditNotes: string[] = [];

    // Check Painted Desert
    const pdWp = tripContext.waypoints.find(
      (w) => w.id === 'painted_desert_view' || (w.lat > 34.97 && w.lat < 34.99 && w.lng < -110.05)
    );
    if (pdWp && (Math.abs(pdWp.lat - 34.9809) > 0.0005 || Math.abs(pdWp.lng - (-110.0525)) > 0.0005)) {
      auditSuggestions.push({
        id: `scout_audit_pd_${Date.now()}`,
        action: 'update_waypoint',
        targetWaypointId: pdWp.id,
        name: 'Painted Desert Badlands',
        type: 'scenic_pull_off',
        lat: 34.9809,
        lng: -110.0525,
        dwell_minutes: 0,
        trigger_radius_miles: 4.0,
        reason: 'Snaps coordinate from Goodwater Rd dirt track back to I-40 East centerline to eliminate off-highway detour.',
        notification: {
          title: 'Painted Desert Scenery',
          message: 'Look north of I-40 near Holbrook for vivid badlands views.',
          speech: 'Scenic alert: Passing the Painted Desert badlands to the north of Interstate 40.',
        },
      });
      auditNotes.push('**Painted Desert Badlands**: Relocated from a dirt road south of I-40 directly onto the I-40 East centerline.');
    }

    // Check Gallup / Red Rock Park mismatch (ID is still gallup_fuel or speech/card still mentions fuel stop)
    const gallupWp = tripContext.waypoints.find(
      (w) =>
        w.id === 'gallup_fuel' ||
        (w.name.toLowerCase().includes('red rock') &&
          (w.id.toLowerCase().includes('fuel') ||
            (w.notification && w.notification.speech.toLowerCase().includes('fuel')))) ||
        (w.type === 'meal' &&
          (w.id.toLowerCase().includes('fuel') ||
            (w.notification && w.notification.speech.toLowerCase().includes('fuel'))))
    );
    if (gallupWp) {
      auditSuggestions.push({
        id: `scout_audit_gallup_${Date.now()}`,
        action: 'update_waypoint',
        targetWaypointId: gallupWp.id,
        newId: 'gallup_red_rock_park',
        name: 'Red Rock Park (Picnic & Stretch)',
        type: 'meal',
        lat: gallupWp.lat,
        lng: gallupWp.lng,
        dwell_minutes: 30,
        trigger_radius_miles: 3.0,
        reason: "Synchronizes waypoint ID to 'gallup_red_rock_park' and updates heads-up alert & voice notification from obsolete fuel text to picnic, lunch, and red rock park audio.",
        notification: {
          title: 'Red Rock Park Picnic & Stretch',
          message: 'Target 11:30 AM MDT. 30-min picnic break & stretch among red rock cliffs before US-491.',
          speech: 'Arriving at Red Rock Park outside Gallup. Note the one-hour time change to Mountain Daylight Time. Recommended thirty-minute picnic break and stretch before heading north on Highway 491.',
        },
      });
      auditNotes.push('**Red Rock Park (Picnic & Stretch)**: Synchronized waypoint ID to `gallup_red_rock_park` and replaced obsolete fuel stop card title and voice alert with updated picnic and park copy.');
    }

    // Check Shiprock Peak
    const srWp = tripContext.waypoints.find(
      (w) => w.id === 'shiprock_peak' || (w.lat > 36.67 && w.lat < 36.70 && w.lng > -108.70 && w.lng < -108.67)
    );
    if (srWp && (Math.abs(srWp.lat - 36.6878) > 0.0005 || Math.abs(srWp.lng - (-108.7078)) > 0.0005)) {
      auditSuggestions.push({
        id: `scout_audit_sr_${Date.now()}`,
        action: 'update_waypoint',
        targetWaypointId: srWp.id,
        name: 'Shiprock Peak (US-491)',
        type: 'scenic_pull_off',
        lat: 36.6878,
        lng: -108.7078,
        dwell_minutes: 0,
        trigger_radius_miles: 6.0,
        reason: 'Aligns pin directly on US-491 North abreast of the peak, eliminating a 2.3-mile off-road detour onto tribal land.',
        notification: {
          title: 'Shiprock Landmark Ahead',
          message: '1,583-ft volcanic peak visible for miles. View from highway only (sacred tribal land).',
          speech: 'Upcoming sight on your left: Shiprock Peak, rising fifteen hundred feet from the desert floor. Highway viewing only as this is sacred Navajo land.',
        },
      });
      auditNotes.push('**Shiprock Peak**: Moved from desert scrub back to US-491 North for highway viewing without leaving the route.');
    }

    // Check Farmington Fuel Stop
    const fuelWp = tripContext.waypoints.find(
      (w) =>
        w.id === 'wp_1789354019621_9s3w' ||
        w.name.toLowerCase().includes('maverik') ||
        (w.type === 'fuel' && w.lat > 36.73 && w.lat < 36.76)
    );
    if (fuelWp && (Math.abs(fuelWp.lat - 36.7328) > 0.005 || Math.abs(fuelWp.lng - (-108.2443)) > 0.005)) {
      auditSuggestions.push({
        id: `scout_audit_fuel_${Date.now()}`,
        action: 'update_waypoint',
        targetWaypointId: fuelWp.id,
        newId: 'maverik_farmington',
        name: "Maverik Adventure's First Stop (Farmington)",
        type: 'fuel',
        lat: 36.7328,
        lng: -108.2443,
        dwell_minutes: 15,
        trigger_radius_miles: 1.5,
        reason: 'Relocated from residential mobile home park to the authentic Maverik commercial station at 2710 W Main St on US-64 with multiple pumps and clean restrooms.',
        notification: {
          title: 'Maverik Fuel & Food Stop',
          message: '2710 W Main St on US-64. Fuel pumps, clean restrooms, and refreshments.',
          speech: 'Approaching Maverik Adventure Stop on West Main Street. Recommended 15 minute fuel and rest break before heading into the mountains.',
        },
      });
      auditNotes.push("**Farmington Fuel Stop**: Corrected from a residential mobile home park on Finch Ave to the genuine Maverik commercial station at 2710 W Main St on US-64.");
    }

    // Check Dulce Foothills
    const dulceWp = tripContext.waypoints.find(
      (w) => w.id === 'dulce_foothills' || (w.lat > 36.92 && w.lng < -106.99)
    );
    if (dulceWp && (Math.abs(dulceWp.lat - 36.9107) > 0.001 || Math.abs(dulceWp.lng - (-106.9996)) > 0.001)) {
      auditSuggestions.push({
        id: `scout_audit_dulce_${Date.now()}`,
        action: 'update_waypoint',
        targetWaypointId: dulceWp.id,
        name: 'Jicarilla Apache Nation / Dulce',
        type: 'scenic_pull_off',
        lat: 36.9107,
        lng: -106.9996,
        dwell_minutes: 0,
        trigger_radius_miles: 3.0,
        reason: 'Snaps coordinate to US-64 East highway corridor, eliminating residential side-street detour.',
        notification: {
          title: 'Climbing into Pine & Aspen Country',
          message: 'US-64 climbing toward Chama. Early autumn foliage.',
          speech: 'Climbing through the Jicarilla Apache Nation on US-64. Watch for early autumn aspen color as we enter the foothills.',
        },
      });
      auditNotes.push('**Jicarilla Apache Nation / Dulce**: Snapped to US-64 East centerline to remove the 1.5-mile residential spur.');
    }

    // Check Chama Arrival
    const chamaWp = tripContext.waypoints.find(
      (w) => w.id === 'chama_arrival' || (w.lat > 36.87 && w.lat < 36.89 && w.lng > -106.59 && w.lng < -106.57)
    );
    if (chamaWp && Math.abs(chamaWp.lat - 36.8748) > 0.002) {
      auditSuggestions.push({
        id: `scout_audit_chama_${Date.now()}`,
        action: 'update_waypoint',
        targetWaypointId: chamaWp.id,
        name: 'Chama / Vista Del Rio Lodge',
        type: 'lodging',
        lat: 36.8748,
        lng: -106.5835,
        dwell_minutes: 0,
        trigger_radius_miles: 1.0,
        reason: 'Positions arrival at the genuine lodge property on US-64 in Chama.',
        notification: {
          title: 'Arrival in Chama',
          message: 'Target 5:00-5:30 PM. Check-in at Vista Del Rio Lodge. Dinner at Local.',
          speech: 'Welcome to Chama. Vista Del Rio Lodge is on the right. Dinner tonight is at Local on Terrace Avenue.',
        },
      });
      auditNotes.push('**Chama Arrival**: Positioned directly at Vista Del Rio Lodge on US-64.');
    }

    if (auditSuggestions.length > 0) {
      return {
        reply: `### Route Audit & Highway Alignment Report\n\nI have reviewed the waypoints along the **${origin} → ${dest}** corridor. Here are the issues identified and corrected:\n\n${auditNotes.map((n) => `- ${n}`).join('\n')}\n\nDrive-by waypoints (0m dwell) are now strictly pinned to the highway centerline, preventing routing detours onto unpaved tracks or neighborhood side streets. Commercial stops and meal breaks have synchronized waypoint IDs, realistic highway access, and fully updated heads-up and spoken voice alerts. You can click **Preview** on each card below or **Update** to apply the fixes directly to your timeline.`,
        suggestions: auditSuggestions,
      };
    }
  }

  if (lastMessage.includes('lunch') || lastMessage.includes('food') || lastMessage.includes('eat') || lastMessage.includes('dine')) {
    const midwayLat = tripContext.waypoints.length > 0 ? (tripContext.waypoints[0].lat + tripContext.waypoints[tripContext.waypoints.length - 1].lat) / 2 : 35.5;
    const midwayLng = tripContext.waypoints.length > 0 ? (tripContext.waypoints[0].lng + tripContext.waypoints[tripContext.waypoints.length - 1].lng) / 2 : -109.5;

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
      `Is the coordinate for ${name} directly on the highway?`,
      `Check if alert notification and speech match ${name}`,
      `Check parking and road accessibility for ${name}`,
      `Suggest a better scenic overlook or photo spot near ${name}`,
      `Is our planned dwell time appropriate for ${name}?`,
    ];
  }

  return [
    'Where should we stop for lunch along this leg?',
    'Audit route coordinates for off-highway detours',
    'Audit waypoints for outdated alerts, IDs, or fuel/meal mismatches',
    'Verify fuel stops have commercial amenities & clean restrooms',
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

    // 1. Try Primary: agy adapter
    if (preferredEngine !== 'cloud') {
      const agy = this.aiService.getAdapter('agy');
      if (agy) {
        try {
          const prompt = agy.decorateScoutPrompt ? agy.decorateScoutPrompt(domainPrompt) : domainPrompt;
          const rawOutput = await agy.generate(prompt);
          const sanitized = agy.sanitizeResponse ? agy.sanitizeResponse(rawOutput) : rawOutput;
          const { reply, suggestions, thought } = parseScoutResponse(sanitized);
          return { reply, suggestions, sessionId, engine: 'agy', thought };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          lastError = msg;
          console.warn(`[RouteScout] agy adapter generation failed (${msg}), attempting cloud fallback...`);
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
          const { reply, suggestions, thought } = parseScoutResponse(sanitized);
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
        : `Route Scout error: ${lastError || 'unable to connect to an AI model. Please verify your local agy CLI or AI Studio API key.'}`
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
          const { reply, suggestions, thought } = parseScoutResponse(sanitized);
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
        const { reply, suggestions, thought } = parseScoutResponse(sanitized);
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
