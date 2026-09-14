import type {
  ScoutScope,
  ScoutSuggestion,
  ScoutChatRequest,
  ScoutChatResponse,
  ScoutStreamEvent,
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
        contextBlock += `  - ${wp.name} (${wp.type}) @ ${wp.lat.toFixed(4)}, ${wp.lng.toFixed(4)}\n`;
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
6. Provide accurate, real-world coordinates directly on or adjacent to the highway corridor for all candidate suggestions.

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
    "reason": "Clear explanation of why this stop is recommended."
  },
  {
    "action": "update_waypoint",
    "targetWaypointId": "target_id",
    "name": "Updated Name",
    "type": "scenic_pull_off",
    "lat": 35.5678,
    "lng": -111.1234,
    "dwell_minutes": 15,
    "trigger_radius_miles": 3.0,
    "reason": "Explanation of the correction or improvement."
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

    if (lastMessage.includes('park') || lastMessage.includes('access') || lastMessage.includes('road')) {
      return {
        reply: `### Waypoint Accessibility: ${name}\n\nBased on regional road attributes, highway pull-offs typically have designated paved shoulders or roadside gravel aprons. If traveling with a standard passenger car or rental SUV, exercise caution with unpaved road shoulders after rain.\n\nYou can click **Preview on Map** to zoom in and check satellite imagery against the road alignment.`,
        suggestions: [],
      };
    }

    if (lastMessage.includes('coord') || lastMessage.includes('wrong') || lastMessage.includes('fix') || lastMessage.includes('shift')) {
      return {
        reply: `### Coordinate Verification: ${name}\n\nWhen verifying a waypoint along a highway corridor, ensure the pin is placed directly on the paved roadway or an authorized pull-off rather than on backcountry dirt tracks. You can drag the marker directly on the map canvas or use the search bar to lock to a street address.`,
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
      `Check parking and road accessibility for ${name}`,
      `Suggest a better scenic overlook or photo spot near ${name}`,
      `Is our planned dwell time appropriate for ${name}?`,
    ];
  }

  return [
    'Where should we stop for lunch along this leg?',
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
          const rawOutput = await agy.generateStream(prompt, (chunk) => {
            if (chunk.type === 'thought') {
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
          const doneResponse: ScoutChatResponse = { reply, suggestions, sessionId, engine: 'agy', thought };
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
