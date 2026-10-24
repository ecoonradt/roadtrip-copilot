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

/**
 * Identifier of the AI provider adapter that produced a result.
 * Any registered `AiHarnessAdapter.id` is valid; unknown ids are rejected at runtime.
 */
export type AiEngineId = string;

export interface AiModelOption {
  id: string;
  name: string;
  provider: string;
  description: string;
  role: 'scout' | 'copywriter' | 'both';
}

export interface AiStatusResult {
  available: boolean;
  engine?: AiEngineId;
  providerName?: string;
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
  engine: AiEngineId;
}

export interface BatchAlertResult {
  alerts: Record<string, CopilotAlert>;
  results: Array<{ id: string; alert: CopilotAlert }>;
  /** Omitted for an empty batch, where no provider was invoked. */
  engine?: AiEngineId;
}
