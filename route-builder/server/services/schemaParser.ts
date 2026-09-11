import type { CopilotAlert, WaypointContext } from '../types/ai.js';

/**
 * Truncates title to <= 30 characters safely without breaking words where possible.
 */
export function sanitizeTitle(raw: unknown, fallbackName?: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    const base = (fallbackName || 'Waypoint').trim();
    const candidate = `${base.slice(0, 22)} Ahead`;
    return sanitizeTitle(candidate);
  }

  let text = raw.trim().replace(/\s+/g, ' ');

  if (text.length <= 30) {
    return text;
  }

  // Find last space before or at index 30
  const cutoff = 30;
  const lastSpace = text.lastIndexOf(' ', cutoff);

  if (lastSpace > 10) {
    text = text.slice(0, lastSpace);
  } else {
    text = text.slice(0, cutoff);
  }

  // Clean trailing punctuation or whitespace
  text = text.replace(/[\s,:;\-_.]+$/, '').trim();

  return text.slice(0, 30);
}

/**
 * Normalizes message to at most 2 lines and trims excess whitespace.
 */
export function sanitizeMessage(raw: unknown, defaultTip?: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    return defaultTip || 'Drive carefully and monitor route progress.';
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return defaultTip || 'Drive carefully and monitor route progress.';
  }

  // Take at most 2 lines
  return lines.slice(0, 2).join('\n');
}

/**
 * Cleans conversational speech text for Android TextToSpeech.
 * Strips markdown and ensures clean sentence structure.
 */
export function sanitizeSpeech(raw: unknown, defaultSpeech?: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    return defaultSpeech || 'Approaching your scheduled road trip stop.';
  }

  // Strip markdown, brackets, HTML tags, and extra symbols
  let cleaned = raw
    .replace(/\*\*|__|\*|_|`|#+/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return defaultSpeech || 'Approaching your scheduled road trip stop.';
  }

  return cleaned;
}

/**
 * Clamps trigger radius strictly between 0.3 and 6.0 miles.
 */
export function clampRadius(raw: unknown, defaultRadius = 2.0): number {
  let val: number;
  if (typeof raw === 'number') {
    val = raw;
  } else if (typeof raw === 'string') {
    val = parseFloat(raw);
  } else {
    val = defaultRadius;
  }

  if (Number.isNaN(val) || !Number.isFinite(val)) {
    val = defaultRadius;
  }

  // Clamp strictly between 0.3 and 6.0
  const clamped = Math.min(6.0, Math.max(0.3, val));
  return Math.round(clamped * 10) / 10;
}

/**
 * Deterministic template fallback generator for offline resilience or failed AI calls.
 */
export function generateTemplateAlert(waypoint: WaypointContext): CopilotAlert {
  const shortName = waypoint.name ? waypoint.name.split(',')[0].trim() : 'Scheduled Stop';
  const title = sanitizeTitle(`${shortName} Ahead`, shortName);

  let tip = 'Follow signs and drive safely.';
  let radius = 2.0;

  switch (waypoint.type) {
    case 'origin':
    case 'destination':
    case 'lodging':
      tip = 'Check-in and arrival destination.';
      radius = 0.5;
      break;
    case 'meal':
      tip = 'Scheduled stop for dining and rest.';
      radius = 1.0;
      break;
    case 'fuel':
      tip = 'Fuel stop and vehicle inspection.';
      radius = 1.0;
      break;
    case 'highway_vista':
      tip = 'Scenic highway vista visible from road.';
      radius = 3.5;
      break;
    case 'scenic_pull_off':
    default:
      tip = 'Scenic pull-off ahead for photos and views.';
      radius = 2.5;
      break;
  }

  const timeStr = waypoint.formattedTime || waypoint.targetTime || 'shortly';
  const message = sanitizeMessage(`Target arrival: ${timeStr}.\n${tip}`);
  const hwy = waypoint.approachHighway ? ` on ${waypoint.approachHighway}` : '';
  const speech = sanitizeSpeech(
    `Approaching ${shortName}${hwy}. Target arrival is ${timeStr}. ${tip}`
  );

  return {
    title,
    message,
    speech,
    recommended_trigger_radius_miles: clampRadius(radius),
  };
}

/**
 * Extracts JSON content from raw LLM output (handles code fences).
 */
export function extractJsonString(raw: string): string {
  let text = raw.trim();

  // Strip markdown code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // If text starts with non-JSON characters, locate first { or [
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');

  let startIdx = -1;
  if (firstBrace !== -1 && firstBracket !== -1) {
    startIdx = Math.min(firstBrace, firstBracket);
  } else if (firstBrace !== -1) {
    startIdx = firstBrace;
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
  }

  if (startIdx > 0) {
    text = text.slice(startIdx);
  }

  return text;
}

/**
 * Parses raw model output string into a JavaScript object, unwrapping agy envelope if present.
 */
export function parseModelOutput(rawOutput: string): unknown {
  const jsonText = extractJsonString(rawOutput);
  let parsed = JSON.parse(jsonText);

  if (parsed && typeof parsed === 'object' && 'response' in parsed) {
    const envelopeResponse = (parsed as { response: unknown }).response;
    if (typeof envelopeResponse === 'string') {
      try {
        parsed = JSON.parse(extractJsonString(envelopeResponse));
      } catch {
        parsed = envelopeResponse;
      }
    } else if (typeof envelopeResponse === 'object' && envelopeResponse !== null) {
      parsed = envelopeResponse;
    }
  }

  return parsed;
}

/**
 * Parses a single raw object into a validated, sanitized CopilotAlert.
 */
export function parseCopilotAlert(raw: unknown, waypoint?: WaypointContext): CopilotAlert {
  if (!raw || typeof raw !== 'object') {
    return waypoint ? generateTemplateAlert(waypoint) : {
      title: 'Waypoint Ahead',
      message: 'Approaching scheduled waypoint.\nDrive safely.',
      speech: 'Approaching your scheduled road trip stop.',
      recommended_trigger_radius_miles: 2.0,
    };
  }

  let obj = raw as Record<string, unknown>;

  // Check if wrapped in envelope response
  if (obj.response) {
    if (typeof obj.response === 'object' && obj.response !== null) {
      obj = obj.response as Record<string, unknown>;
    } else if (typeof obj.response === 'string') {
      try {
        obj = JSON.parse(extractJsonString(obj.response)) as Record<string, unknown>;
      } catch {
        // keep obj
      }
    }
  }

  // Check if wrapped in alert or notification
  const targetObj = (obj.alert && typeof obj.alert === 'object'
    ? obj.alert
    : obj.notification && typeof obj.notification === 'object'
    ? obj.notification
    : obj) as Record<string, unknown>;

  const defaultTemplate = waypoint ? generateTemplateAlert(waypoint) : undefined;

  const title = sanitizeTitle(
    targetObj.title,
    waypoint?.name || defaultTemplate?.title || 'Waypoint'
  );

  const message = sanitizeMessage(
    targetObj.message,
    defaultTemplate?.message
  );

  const speech = sanitizeSpeech(
    targetObj.speech || targetObj.spoken_text || targetObj.audio_script,
    defaultTemplate?.speech
  );

  const rawRadius =
    targetObj.recommended_trigger_radius_miles ??
    targetObj.trigger_radius_miles ??
    targetObj.radius_miles ??
    targetObj.radius;

  const recommended_trigger_radius_miles = clampRadius(
    rawRadius,
    defaultTemplate?.recommended_trigger_radius_miles ?? 2.0
  );

  return {
    title,
    message,
    speech,
    recommended_trigger_radius_miles,
  };
}

/**
 * Parses batch response into a dictionary keyed by waypoint ID.
 */
export function parseBatchCopilotAlerts(
  raw: unknown,
  waypoints: WaypointContext[]
): Record<string, CopilotAlert> {
  const result: Record<string, CopilotAlert> = {};

  if (!raw) {
    for (const wp of waypoints) {
      result[wp.id] = generateTemplateAlert(wp);
    }
    return result;
  }

  // Unpack agy CLI envelope if present
  if (typeof raw === 'object' && raw !== null) {
    const rawObj = raw as Record<string, unknown>;
    if (rawObj.response) {
      if (typeof rawObj.response === 'object' && rawObj.response !== null) {
        raw = rawObj.response;
      } else if (typeof rawObj.response === 'string') {
        try {
          raw = JSON.parse(extractJsonString(rawObj.response));
        } catch {
          // ignore
        }
      }
    }
  }


  // If raw is an array of items: [{ id: "...", title: "..." }] or [{ waypointId: "...", alert: {...} }]
  if (Array.isArray(raw)) {
    const map = new Map<string, unknown>();
    for (const item of raw) {
      if (item && typeof item === 'object') {
        const itemObj = item as Record<string, unknown>;
        const id = (itemObj.id || itemObj.waypointId || itemObj.waypoint_id) as string | undefined;
        if (id) {
          map.set(id, itemObj);
        }
      }
    }

    for (let i = 0; i < waypoints.length; i++) {
      const wp = waypoints[i];
      const match = map.get(wp.id) || raw[i];
      result[wp.id] = parseCopilotAlert(match, wp);
    }
    return result;
  }

  // If raw is an object
  if (typeof raw === 'object') {
    const rawObj = raw as Record<string, unknown>;
    const container =
      rawObj.alerts && typeof rawObj.alerts === 'object' && !Array.isArray(rawObj.alerts)
        ? (rawObj.alerts as Record<string, unknown>)
        : rawObj.waypoints && typeof rawObj.waypoints === 'object' && !Array.isArray(rawObj.waypoints)
        ? (rawObj.waypoints as Record<string, unknown>)
        : rawObj;

    for (const wp of waypoints) {
      const candidate = container[wp.id];
      result[wp.id] = parseCopilotAlert(candidate, wp);
    }
    return result;
  }

  // Fallback if unrecognized type
  for (const wp of waypoints) {
    result[wp.id] = generateTemplateAlert(wp);
  }

  return result;
}
