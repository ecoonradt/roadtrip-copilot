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

export type AiEngineType = 'bedrock' | 'agy' | 'cloud' | 'template';

export interface AiModelOption {
  id: string;
  name: string;
  provider: string;
  description: string;
  role: 'scout' | 'copywriter' | 'both';
}

export interface ToolDeclaration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface GenerateOptions {
  apiKey?: string;
  modelId?: string;
  abortSignal?: AbortSignal;
}

export interface GenerateStreamWithToolsResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AiStatusResult {
  available: boolean;
  engine?: AiEngineType;
  models?: AiModelOption[];
  defaultScoutModelId?: string;
  defaultCopywriterModelId?: string;
  message?: string;
}

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
