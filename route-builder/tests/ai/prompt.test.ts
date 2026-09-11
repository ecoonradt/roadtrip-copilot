import { describe, it, expect } from 'vitest';
import {
  buildSingleWaypointPrompt,
  buildBatchWaypointPrompt,
  formatHighwayPronunciation,
} from '../../server/services/promptBuilder.js';
import type { WaypointContext } from '../../server/types/ai.js';

describe('AI Co-Pilot Prompt Generator', () => {
  const sampleWaypoint: WaypointContext = {
    id: 'wp_sedona_bell_rock',
    name: 'Sedona Red Rock Vistas (Bell Rock)',
    type: 'scenic_pull_off',
    targetTime: '16:30:00',
    formattedTime: '4:30 PM',
    approachHighway: 'AZ-179 North',
    notes: 'Famous red rock buttes and hiking trailheads',
  };

  it('Scenario 1: Correctly formats all contextual parameters in single waypoint prompt', () => {
    const prompt = buildSingleWaypointPrompt(sampleWaypoint);

    // Contextual parameters must be included
    expect(prompt).toContain('wp_sedona_bell_rock');
    expect(prompt).toContain('Sedona Red Rock Vistas (Bell Rock)');
    expect(prompt).toContain('scenic_pull_off');
    expect(prompt).toContain('16:30:00 (4:30 PM)');
    expect(prompt).toContain('AZ-179 North');
    expect(prompt).toContain('Famous red rock buttes and hiking trailheads');

    // Section 4.4 Co-pilot Prompt Contract rules must be present
    expect(prompt).toContain('Title: Under 30 characters');
    expect(prompt).toContain('Message: 1-2 concise lines');
    expect(prompt).toContain('Speech: Written for offline Android TextToSpeech');
    expect(prompt).toContain('Tone: Friendly, professional co-pilot');
    expect(prompt).toContain('Length: 15-25 words');
    expect(prompt).toContain('Recommended Trigger Radius');
    expect(prompt).toContain('strict JSON');
  });

  it('Formats highway pronunciations accurately', () => {
    expect(formatHighwayPronunciation('AZ-179')).toBe('Highway 179');
    expect(formatHighwayPronunciation('I-17 N')).toBe('Interstate 17 North');
    expect(formatHighwayPronunciation('I-40 W')).toBe('Interstate 40 West');
    expect(formatHighwayPronunciation('US-89A')).toBe('Highway 89A');
    expect(formatHighwayPronunciation('NM-64')).toBe('New Mexico Highway 64');
  });

  it('Handles missing optional waypoint fields with sensible defaults', () => {
    const minimalWaypoint: WaypointContext = {
      id: 'wp_minimal',
      name: 'Generic Overlook',
    };

    const prompt = buildSingleWaypointPrompt(minimalWaypoint);

    expect(prompt).toContain('wp_minimal');
    expect(prompt).toContain('Generic Overlook');
    expect(prompt).toContain('scenic_pull_off'); // default type
    expect(prompt).toContain('Unscheduled');
    expect(prompt).toContain('Scenic roadway');
    expect(prompt).toContain('None'); // default notes
  });

  it('Formats batch prompt with multiple waypoints and batch JSON contract', () => {
    const waypoints: WaypointContext[] = [
      sampleWaypoint,
      {
        id: 'wp_flagstaff_hotel',
        name: 'Little America Hotel Flagstaff',
        type: 'lodging',
        targetTime: '18:15:00',
        formattedTime: '6:15 PM',
        approachHighway: 'I-40 East',
        notes: 'Ponderosa pine lodge retreat',
      },
    ];

    const batchPrompt = buildBatchWaypointPrompt(waypoints);

    expect(batchPrompt).toContain('each of the following 2 waypoints');
    expect(batchPrompt).toContain('wp_sedona_bell_rock');
    expect(batchPrompt).toContain('wp_flagstaff_hotel');
    expect(batchPrompt).toContain('Little America Hotel Flagstaff');
    expect(batchPrompt).toContain('Ponderosa pine lodge retreat');
    expect(batchPrompt).toContain('Respond in strict JSON with an object where each key is the waypoint ID');
  });
});
