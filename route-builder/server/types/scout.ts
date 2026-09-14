import type { AiEngineType } from './ai.js';

export interface ScoutScope {
  type: 'day' | 'waypoint';
  dayNumber?: number;
  dayTitle?: string;
  waypointId?: string;
  waypointName?: string;
}

export interface ScoutWaypointSummary {
  id: string;
  name: string;
  type: string;
  lat: number;
  lng: number;
  target_time?: string;
  dwell_minutes?: number;
  trigger_radius_miles?: number;
  notes?: string;
  notification?: {
    title: string;
    message: string;
    speech: string;
  };
}

export interface ScoutTripContext {
  tripName: string;
  date?: string;
  origin?: string;
  destination?: string;
  departureTime?: string;
  corridor?: string;
  waypoints: ScoutWaypointSummary[];
  focusedWaypoint?: ScoutWaypointSummary;
}

export interface ScoutSuggestion {
  id: string;
  action: 'add_waypoint' | 'update_waypoint';
  name: string;
  type: string;
  lat: number;
  lng: number;
  dwell_minutes?: number;
  trigger_radius_miles?: number;
  reason: string;
  insertAfterWaypointId?: string;
  targetWaypointId?: string;
  newId?: string;
  notification?: {
    title: string;
    message: string;
    speech: string;
  };
}

export interface ScoutActivity {
  id: string;
  type: 'search' | 'command' | 'tool' | 'thought';
  label: string;
  detail?: string;
  state: 'active' | 'done' | 'error';
  durationSeconds?: number;
}

export interface ScoutMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  suggestions?: ScoutSuggestion[];
  engine?: AiEngineType;
  thought?: string;
  activities?: ScoutActivity[];
}

export interface ScoutChatRequest {
  scope: ScoutScope;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tripContext: ScoutTripContext;
  sessionId?: string;
}

export interface ScoutChatResponse {
  reply: string;
  suggestions: ScoutSuggestion[];
  sessionId: string;
  engine: AiEngineType;
  thought?: string;
  activities?: ScoutActivity[];
}

export type ScoutStreamEvent =
  | { event: 'thought'; data: { text: string } }
  | { event: 'activity'; data: ScoutActivity }
  | { event: 'delta'; data: { text: string } }
  | { event: 'suggestions'; data: { suggestions: ScoutSuggestion[] } }
  | { event: 'done'; data: ScoutChatResponse }
  | { event: 'error'; data: { error: string } };

export interface ScoutQuickPromptsResponse {
  prompts: string[];
}
