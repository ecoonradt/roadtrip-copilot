import type { CopilotAlert, WaypointContext } from '../types/ai.js';

/**
 * Raised when a provider response does not satisfy the co-pilot alert contract.
 * Routes map this to HTTP 502 (upstream returned an unusable payload); it is never
 * silently repaired with placeholder copy.
 */
export class MalformedAiResponseError extends Error {
  readonly statusCode = 502;

  constructor(message: string) {
    super(message);
    this.name = 'MalformedAiResponseError';
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MalformedAiResponseError(`AI response is missing a valid "${field}" value`);
  }
  return value;
}

function requireRadius(value: unknown): number | string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new MalformedAiResponseError('AI response contains an invalid "recommended_trigger_radius_miles" value');
    }
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number.parseFloat(value))) {
    return value;
  }
  throw new MalformedAiResponseError('AI response is missing a valid "recommended_trigger_radius_miles" value');
}

/**
 * Truncates title to <= 30 characters safely without breaking words where possible.
 */
export function sanitizeTitle(raw: string): string {
  let text = raw.trim().replace(/\s+/g, ' ');
  if (!text) {
    throw new MalformedAiResponseError('AI response is missing a valid "title" value');
  }

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
export function sanitizeMessage(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new MalformedAiResponseError('AI response is missing a valid "message" value');
  }

  // Take at most 2 lines
  return lines.slice(0, 2).join('\n');
}

/**
 * Cleans conversational speech text for Android TextToSpeech.
 * Strips markdown and ensures clean sentence structure.
 */
export function sanitizeSpeech(raw: string): string {
  const cleaned = raw
    .replace(/\*\*|__|\*|_|`|#+/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    throw new MalformedAiResponseError('AI response is missing a valid "speech" value');
  }

  return cleaned;
}

/**
 * Clamps trigger radius strictly between 0.3 and 6.0 miles.
 */
export function clampRadius(raw: number | string): number {
  const val = typeof raw === 'number' ? raw : Number.parseFloat(raw);
  if (Number.isNaN(val) || !Number.isFinite(val)) {
    throw new MalformedAiResponseError('AI response contains an invalid "recommended_trigger_radius_miles" value');
  }

  // Clamp strictly between 0.3 and 6.0
  const clamped = Math.min(6.0, Math.max(0.3, val));
  return Math.round(clamped * 10) / 10;
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
 * Parses raw model output string into a JavaScript object, unwrapping a legacy `response` envelope if present.
 */
export function parseModelOutput(rawOutput: string): unknown {
  const jsonText = extractJsonString(rawOutput);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new MalformedAiResponseError('AI response was not valid JSON');
  }

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
 * Throws `MalformedAiResponseError` when a required field is missing or invalid.
 */
export function parseCopilotAlert(raw: unknown): CopilotAlert {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MalformedAiResponseError('AI response did not contain an alert object');
  }

  let obj = raw as Record<string, unknown>;

  // Check if wrapped in envelope response
  if (obj.response) {
    if (typeof obj.response === 'object' && obj.response !== null) {
      obj = obj.response as Record<string, unknown>;
    } else if (typeof obj.response === 'string') {
      try {
        const unwrapped: unknown = JSON.parse(extractJsonString(obj.response));
        if (!unwrapped || typeof unwrapped !== 'object' || Array.isArray(unwrapped)) {
          throw new MalformedAiResponseError('AI response did not contain an alert object');
        }
        obj = unwrapped as Record<string, unknown>;
      } catch (err: unknown) {
        if (err instanceof MalformedAiResponseError) throw err;
        throw new MalformedAiResponseError('AI response contained an unparseable "response" envelope');
      }
    }
  }

  // Check if wrapped in alert or notification
  const targetObj = (obj.alert && typeof obj.alert === 'object'
    ? obj.alert
    : obj.notification && typeof obj.notification === 'object'
    ? obj.notification
    : obj) as Record<string, unknown>;

  const title = sanitizeTitle(requireNonEmptyString(targetObj.title, 'title'));
  const message = sanitizeMessage(requireNonEmptyString(targetObj.message, 'message'));

  const speechSource = targetObj.speech ?? targetObj.spoken_text ?? targetObj.audio_script;
  const speech = sanitizeSpeech(requireNonEmptyString(speechSource, 'speech'));

  const rawRadius =
    targetObj.recommended_trigger_radius_miles ??
    targetObj.trigger_radius_miles ??
    targetObj.radius_miles ??
    targetObj.radius;

  const recommended_trigger_radius_miles = clampRadius(requireRadius(rawRadius));

  return {
    title,
    message,
    speech,
    recommended_trigger_radius_miles,
  };
}

/**
 * Parses batch response into a dictionary keyed by waypoint ID.
 * Throws `MalformedAiResponseError` when the payload is unusable or omits a waypoint.
 */
export function parseBatchCopilotAlerts(
  raw: unknown,
  waypoints: WaypointContext[]
): Record<string, CopilotAlert> {
  if (!raw || typeof raw !== 'object') {
    throw new MalformedAiResponseError('AI response did not contain a batch alert payload');
  }

  // Unpack legacy `response` envelope if present
  if (!Array.isArray(raw)) {
    const rawObj = raw as Record<string, unknown>;
    if (rawObj.response) {
      if (typeof rawObj.response === 'object' && rawObj.response !== null) {
        raw = rawObj.response;
      } else if (typeof rawObj.response === 'string') {
        try {
          raw = JSON.parse(extractJsonString(rawObj.response));
        } catch {
          throw new MalformedAiResponseError('AI response contained an unparseable "response" envelope');
        }
      }
    }
  }

  const result: Record<string, CopilotAlert> = {};

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
      const match = map.get(wp.id) ?? raw[i];
      if (match === undefined) {
        throw new MalformedAiResponseError(`AI response did not include an alert for waypoint "${wp.id}"`);
      }
      result[wp.id] = parseCopilotAlert(match);
    }
    return result;
  }

  // If raw is an object
  const rawObj = raw as Record<string, unknown>;
  const container =
    rawObj.alerts && typeof rawObj.alerts === 'object' && !Array.isArray(rawObj.alerts)
      ? (rawObj.alerts as Record<string, unknown>)
      : rawObj.waypoints && typeof rawObj.waypoints === 'object' && !Array.isArray(rawObj.waypoints)
      ? (rawObj.waypoints as Record<string, unknown>)
      : rawObj;

  for (const wp of waypoints) {
    const candidate = container[wp.id];
    if (candidate === undefined) {
      throw new MalformedAiResponseError(`AI response did not include an alert for waypoint "${wp.id}"`);
    }
    result[wp.id] = parseCopilotAlert(candidate);
  }
  return result;
}
