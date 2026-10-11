export interface WaypointContext {
  id: string;
  name: string;
  type?: string; // e.g. scenic_pull_off, highway_vista, meal, fuel, lodging, destination, origin
  targetTime?: string;
  formattedTime?: string;
  approachHighway?: string;
  notes?: string;
}

export interface CopilotAlert {
  title: string;
  message: string;
  speech: string;
  recommended_trigger_radius_miles: number;
}

export type AiEngineType = 'agy' | 'cloud' | 'template';

export interface GenerateAlertResult {
  alert: CopilotAlert;
  title: string;
  message: string;
  speech: string;
  recommended_trigger_radius_miles: number;
  engine: AiEngineType;
}

export interface BatchAlertResult {
  alerts: Record<string, CopilotAlert>;
  results: Array<{ id: string; alert: CopilotAlert }>;
  engine: AiEngineType;
}

export interface DayTitleContext {
  dayNumber: number;
  stops: Array<{ name: string; type?: string }>;
}

export interface DayTitleResult {
  title: string;
  engine: AiEngineType;
}
