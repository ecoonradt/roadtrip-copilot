import type { DayTitleContext, WaypointContext } from '../types/ai.js';

/**
 * Phonetic pronunciation hint for highways commonly found in road trip routes.
 */
export function formatHighwayPronunciation(highway: string): string {
  if (!highway) return '';
  return highway
    .replace(/\bUS-(\d+)([A-Z]?)\b/gi, 'Highway $1$2')
    .replace(/\bI-(\d+)\s*([NSEW])\b/gi, (_m, num, dir) => {
      const dirMap: Record<string, string> = { N: 'North', S: 'South', E: 'East', W: 'West' };
      return `Interstate ${num} ${dirMap[dir.toUpperCase()] || dir}`;
    })
    .replace(/\bI-(\d+)\b/gi, 'Interstate $1')
    .replace(/\bSR-(\d+)\b/gi, 'State Route $1');
}

/**
 * Builds prompt for a single waypoint alert generation.
 */
export function buildSingleWaypointPrompt(waypoint: WaypointContext): string {
  const formattedHwy = waypoint.approachHighway
    ? `${waypoint.approachHighway} (Phonetic: "${formatHighwayPronunciation(waypoint.approachHighway)}")`
    : 'Scenic roadway';

  return `You are the Roadtrip Co-Pilot writing assistant. You write concise, high-priority in-car alert cards and spoken audio prompts for an offline Android Auto co-pilot.

Context:
- Waypoint ID: ${waypoint.id}
- Waypoint Name: ${waypoint.name}
- Type: ${waypoint.type || 'scenic_pull_off'}
- Target Arrival Time: ${waypoint.targetTime || 'Unscheduled'}${waypoint.formattedTime ? ` (${waypoint.formattedTime})` : ''}
- Approach Road / Highway: ${formattedHwy}
- User Notes: ${waypoint.notes || 'None'}

Requirements:
1. Title: Under 30 characters. Suitable for Android Auto heads-up card.
2. Message: 1-2 concise lines. Anticipatory ("Approaching..."). Include target time and key driving or stopping tip.
3. Speech: Written for offline Android TextToSpeech.
   - Anticipatory Tense: ALWAYS use future/anticipatory phrasing (e.g. "Approaching [Name] ahead...", "Coming up ahead in about half a mile...", "Prepare to pull into [Name] ahead..."). NEVER use present or past tense ("Now cruising along...", "Driving past...", "Passing...") because this proximity alert triggers in advance of the milestone before reaching it! For scenic drive-bys and route anchors, this prompt is the driver's ONLY alert since non-anchor drive-bys do not appear as intermediate navigation stop pins on Google Maps.
   - Tone: Friendly, professional co-pilot.
   - Pronunciation: Spell out highway numbers naturally (e.g. "Highway one seventy-nine", not "AZ-179").
   - Length: 15-25 words (must speak completely within 8-12 seconds to minimize music ducking).
   - Direction & Lateral Orientation: NEVER guess or assume lateral orientation ("on your right" or "on your left"). Road trips follow winding mountain roads and highways where guessing left vs right is often incorrect and disorients the driver. ONLY specify "on your right" or "on your left" if explicitly provided in the user notes. Otherwise, ALWAYS use neutral directional phrasing such as "ahead", "coming up in two miles", or "prepare to pull into [Name]".
4. Recommended Trigger Radius: Suggest a radius in miles (0.3 to 6.0) based on approach road speed.

Respond in strict JSON:
{
  "title": "...",
  "message": "...",
  "speech": "...",
  "recommended_trigger_radius_miles": 2.0
}`;
}

/**
 * Builds prompt for batch waypoint alert generation.
 */
export function buildBatchWaypointPrompt(waypoints: WaypointContext[]): string {
  const waypointsList = waypoints
    .map((wp, i) => {
      const formattedHwy = wp.approachHighway
        ? `${wp.approachHighway} (Phonetic: "${formatHighwayPronunciation(wp.approachHighway)}")`
        : 'Scenic roadway';
      return `Waypoint ${i + 1}:
  - ID: ${wp.id}
  - Name: ${wp.name}
  - Type: ${wp.type || 'scenic_pull_off'}
  - Target Arrival Time: ${wp.targetTime || 'Unscheduled'}${wp.formattedTime ? ` (${wp.formattedTime})` : ''}
  - Approach Road / Highway: ${formattedHwy}
  - User Notes: ${wp.notes || 'None'}`;
    })
    .join('\n\n');

  return `You are the Roadtrip Co-Pilot writing assistant. You write concise, high-priority in-car alert cards and spoken audio prompts for an offline Android Auto co-pilot.

Generate alert cards and spoken prompts for each of the following ${waypoints.length} waypoints on this road trip day:

${waypointsList}

Requirements for EACH waypoint:
1. Title: Under 30 characters. Suitable for Android Auto heads-up card.
2. Message: 1-2 concise lines. Anticipatory ("Approaching..."). Include target time and key driving or stopping tip.
3. Speech: Written for offline Android TextToSpeech.
   - Anticipatory Tense: ALWAYS use future/anticipatory phrasing (e.g. "Approaching [Name] ahead...", "Coming up ahead in about half a mile...", "Prepare to pull into [Name] ahead..."). NEVER use present or past tense ("Now cruising along...", "Driving past...", "Passing...") because this proximity alert triggers in advance of the milestone before reaching it! For scenic drive-bys and route anchors, this prompt is the driver's ONLY alert since non-anchor drive-bys do not appear as intermediate navigation stop pins on Google Maps.
   - Tone: Friendly, professional co-pilot.
   - Pronunciation: Spell out highway numbers naturally (e.g. "Highway one seventy-nine", not "AZ-179").
   - Length: 15-25 words (must speak completely within 8-12 seconds to minimize music ducking).
   - Direction & Lateral Orientation: NEVER guess or assume lateral orientation ("on your right" or "on your left"). Road trips follow winding mountain roads and highways where guessing left vs right is often incorrect and disorients the driver. ONLY specify "on your right" or "on your left" if explicitly provided in the user notes. Otherwise, ALWAYS use neutral directional phrasing such as "ahead", "coming up in two miles", or "prepare to pull into [Name]".
4. Recommended Trigger Radius: Suggest a radius in miles (0.3 to 6.0) based on approach road speed.

Respond in strict JSON with an object where each key is the waypoint ID and the value is the alert object:
{
  "${waypoints[0]?.id || 'waypoint_id'}": {
    "title": "...",
    "message": "...",
    "speech": "...",
    "recommended_trigger_radius_miles": 2.0
  }
}`;
}

/**
 * Builds a prompt asking for a short, descriptive day title based on the actual stops.
 */
export function buildDayTitlePrompt(ctx: DayTitleContext): string {
  const stops = ctx.stops
    .map((s, i) => `${i + 1}. ${s.name}${s.type ? ` (${s.type})` : ''}`)
    .join('\n');
  return [
    `You name days of a road trip. Write one short, evocative but accurate title for Day ${ctx.dayNumber}, based ONLY on these stops in order:`,
    stops,
    '',
    'Rules: at most 50 characters, no "Day N" prefix, no quotes, mention the start and end area or the highlight of the drive.',
    'Respond with ONLY JSON: {"title": "..."}',
  ].join('\n');
}
