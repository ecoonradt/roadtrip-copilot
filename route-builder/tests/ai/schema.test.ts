import { describe, it, expect } from 'vitest';
import {
  sanitizeTitle,
  sanitizeMessage,
  sanitizeSpeech,
  clampRadius,
  parseCopilotAlert,
  parseBatchCopilotAlerts,
  generateTemplateAlert,
  extractJsonString,
} from '../../server/services/schemaParser.js';
import type { WaypointContext } from '../../server/types/ai.js';

describe('AI Schema Parser & Sanitizer', () => {
  describe('Title Sanitization & Truncation', () => {
    it('Scenario 2A: Preserves titles that are already <= 30 characters', () => {
      const shortTitle = 'Sedona Red Rocks Ahead';
      expect(sanitizeTitle(shortTitle)).toBe('Sedona Red Rocks Ahead');
      expect(sanitizeTitle(shortTitle).length).toBeLessThanOrEqual(30);
    });

    it('Scenario 2B: Catches and truncates titles exceeding 30 characters safely at word boundary', () => {
      // 46 characters
      const longTitle = 'Approaching Beautiful Sedona Bell Rock Vista View';
      const truncated = sanitizeTitle(longTitle);

      expect(truncated.length).toBeLessThanOrEqual(30);
      expect(truncated).toBe('Approaching Beautiful Sedona');
      // Must not end with a partial word or trailing punctuation
      expect(truncated.endsWith(' ')).toBe(false);
      expect(truncated.endsWith(',')).toBe(false);
    });

    it('Safely slices single words exceeding 30 characters', () => {
      const singleLongWord = 'SupercalifragilisticexpialidociousRoadTripStop';
      const result = sanitizeTitle(singleLongWord);
      expect(result.length).toBeLessThanOrEqual(30);
      expect(result).toBe('Supercalifragilisticexpialidoc');
    });

    it('Cleans trailing punctuation when truncating', () => {
      const titleWithPunctuation = 'Sedona Red Rock Vista Overlook, AZ: Scenic';
      const result = sanitizeTitle(titleWithPunctuation);
      expect(result.length).toBeLessThanOrEqual(30);
      expect(result.endsWith(',')).toBe(false);
      expect(result.endsWith(':')).toBe(false);
    });

    it('Handles null, undefined, or empty titles with safe fallback', () => {
      expect(sanitizeTitle('')).toBe('Waypoint Ahead');
      expect(sanitizeTitle(null, 'Montezuma Castle')).toBe('Montezuma Castle Ahead');
      expect(sanitizeTitle(undefined)).toBe('Waypoint Ahead');
    });
  });

  describe('Trigger Radius Clamping', () => {
    it('Scenario 2C: Clamps radius to strictly [0.3, 6.0] miles', () => {
      // Within bounds
      expect(clampRadius(2.5)).toBe(2.5);
      expect(clampRadius(0.3)).toBe(0.3);
      expect(clampRadius(6.0)).toBe(6.0);

      // Underflow
      expect(clampRadius(0.1)).toBe(0.3);
      expect(clampRadius(-2.0)).toBe(0.3);
      expect(clampRadius(0)).toBe(0.3);

      // Overflow
      expect(clampRadius(8.5)).toBe(6.0);
      expect(clampRadius(100)).toBe(6.0);

      // String parsing
      expect(clampRadius('3.2')).toBe(3.2);
      expect(clampRadius('0.05')).toBe(0.3);
      expect(clampRadius('12.0')).toBe(6.0);

      // Non-numeric fallbacks
      expect(clampRadius(NaN)).toBe(2.0);
      expect(clampRadius('invalid')).toBe(2.0);
      expect(clampRadius(undefined)).toBe(2.0);
    });
  });

  describe('Message Normalization', () => {
    it('Scenario 2D: Normalizes multi-line messages to at most 2 lines', () => {
      const fiveLineMessage = `Line 1: Target arrival at 4:30 PM.
Line 2: Recommended 30-min stop for photos.
Line 3: Extra unneeded commentary.
Line 4: Another extra line.
Line 5: Final overflow line.`;

      const normalized = sanitizeMessage(fiveLineMessage);
      const lines = normalized.split('\n');

      expect(lines.length).toBe(2);
      expect(lines[0]).toBe('Line 1: Target arrival at 4:30 PM.');
      expect(lines[1]).toBe('Line 2: Recommended 30-min stop for photos.');
    });

    it('Preserves single-line messages', () => {
      const singleLine = 'Quick 15-minute scenic fuel stop.';
      expect(sanitizeMessage(singleLine)).toBe(singleLine);
    });

    it('Filters blank lines when normalizing', () => {
      const withBlanks = 'First line\n\n\nSecond line\n\nThird line';
      const result = sanitizeMessage(withBlanks);
      expect(result).toBe('First line\nSecond line');
    });
  });

  describe('Speech Script Sanitization', () => {
    it('Strips markdown formatting and HTML tags from speech', () => {
      const markdownSpeech =
        '**Approaching** _Sedona_ on `Highway 179`. Pull-off for #BellRock is on your **right**.';
      const cleaned = sanitizeSpeech(markdownSpeech);

      expect(cleaned).not.toContain('**');
      expect(cleaned).not.toContain('_');
      expect(cleaned).not.toContain('`');
      expect(cleaned).not.toContain('#');
      expect(cleaned).toBe(
        'Approaching Sedona on Highway 179. Pull-off for BellRock is on your right.'
      );
    });

    it('Handles empty or invalid speech with safe fallback', () => {
      expect(sanitizeSpeech('')).toBe('Approaching your scheduled road trip stop.');
      expect(sanitizeSpeech(null)).toBe('Approaching your scheduled road trip stop.');
    });
  });

  describe('JSON Extraction from LLM Output', () => {
    it('Extracts JSON from markdown code blocks', () => {
      const llmOutput = '```json\n{"title": "Test Title", "message": "Test Message"}\n```';
      expect(extractJsonString(llmOutput)).toBe(
        '{"title": "Test Title", "message": "Test Message"}'
      );
    });

    it('Extracts JSON when preceded by conversational commentary', () => {
      const llmOutput = 'Here is your co-pilot notification:\n{"title": "Vista Ahead"}';
      expect(extractJsonString(llmOutput)).toBe('{"title": "Vista Ahead"}');
    });
  });

  describe('Full Alert Parsing & Template Fallback', () => {
    const waypoint: WaypointContext = {
      id: 'wp_test',
      name: 'Oak Creek Vista Overlook',
      type: 'scenic_pull_off',
      targetTime: '17:00:00',
      formattedTime: '5:00 PM',
      approachHighway: 'AZ-89A',
    };

    it('Parses and enforces all schema invariants on raw LLM objects', () => {
      const rawLlmObject = {
        title: 'Approaching Spectacular Oak Creek Vista Switchbacks', // 51 chars
        message: 'Line 1: 5:00 PM arrival.\nLine 2: Stunning views.\nLine 3: Extra.\nLine 4: Overflow.',
        speech: '**Upcoming** sight on your left: Oak Creek switchbacks.',
        recommended_trigger_radius_miles: 15.0, // Should clamp to 6.0
      };

      const parsed = parseCopilotAlert(rawLlmObject, waypoint);

      expect(parsed.title.length).toBeLessThanOrEqual(30);
      expect(parsed.message.split('\n').length).toBeLessThanOrEqual(2);
      expect(parsed.speech).not.toContain('**');
      expect(parsed.recommended_trigger_radius_miles).toBe(6.0);
    });

    it('Generates deterministic template fallback satisfying all schema rules', () => {
      const template = generateTemplateAlert(waypoint);

      expect(template.title.length).toBeLessThanOrEqual(30);
      expect(template.message.split('\n').length).toBeLessThanOrEqual(2);
      expect(template.speech).toContain('Oak Creek Vista Overlook');
      expect(template.recommended_trigger_radius_miles).toBeGreaterThanOrEqual(0.3);
      expect(template.recommended_trigger_radius_miles).toBeLessThanOrEqual(6.0);
    });

    it('Batch parser handles object map format', () => {
      const batchRaw = {
        wp_1: {
          title: 'Stop 1 Ahead',
          message: 'Stop 1 message',
          speech: 'Stop 1 speech text',
          recommended_trigger_radius_miles: 2.0,
        },
      };

      const waypoints: WaypointContext[] = [
        { id: 'wp_1', name: 'Stop 1' },
        { id: 'wp_2', name: 'Stop 2 (Missing in response)' },
      ];

      const result = parseBatchCopilotAlerts(batchRaw, waypoints);

      expect(result.wp_1.title).toBe('Stop 1 Ahead');
      // Missing waypoint wp_2 must have a clean template fallback generated
      expect(result.wp_2).toBeDefined();
      expect(result.wp_2.title.length).toBeLessThanOrEqual(30);
    });

    it('Batch parser handles array format', () => {
      const batchArray = [
        {
          id: 'wp_1',
          title: 'Stop 1 Ahead',
          message: 'Stop 1 message',
          speech: 'Stop 1 speech text',
          recommended_trigger_radius_miles: 1.5,
        },
        {
          id: 'wp_2',
          title: 'Stop 2 Ahead',
          message: 'Stop 2 message',
          speech: 'Stop 2 speech text',
          recommended_trigger_radius_miles: 3.0,
        },
      ];

      const waypoints: WaypointContext[] = [
        { id: 'wp_1', name: 'Stop 1' },
        { id: 'wp_2', name: 'Stop 2' },
      ];

      const result = parseBatchCopilotAlerts(batchArray, waypoints);
      expect(result.wp_1.title).toBe('Stop 1 Ahead');
      expect(result.wp_2.title).toBe('Stop 2 Ahead');
    });
  });
});
