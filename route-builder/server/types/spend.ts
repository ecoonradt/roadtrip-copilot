export const NANOS_PER_USD = 1_000_000_000;

export type SpendOperation =
  | 'copilot_alert'
  | 'copilot_batch_alerts'
  | 'copilot_day_title'
  | 'scout_chat'
  | 'itinerary_storage';

export type TurnStatus = 'success' | 'error' | 'aborted';
export type PaidToolName = 'resolve_and_standardize_place' | 'search_web';

export interface AiUsageEvent {
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  /** Integer nanodollars ($1.00 = 1_000_000_000) computed internally by the adapter. */
  costNanos: number;
  /** True when the adapter used a cached rate table whose refresh is overdue. */
  pricingStale?: boolean;
  /** False only when a streaming call aborted/failed before provider usage metadata arrived. */
  usageComplete: boolean;
}

export interface ToolUsageEvent {
  toolName: PaidToolName;
  provider: 'google_places' | 'brave_search';
  costNanos: number;
}

export interface InfraUsageMetrics {
  lambdaDurationMs: number;
  lambdaRequests: number;
  s3GetOrHeadOps: number;
  s3PutOrListOps: number;
  s3DeleteOps: number;
  cloudFrontRequests: number;
  cloudFrontEgressBytes: number;
  costNanos: number;
}

export interface SpendBreakdownBucket {
  turns: number;
  aiCalls: number;
  unmeteredAiCalls: number;
  stalePricedAiCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  googlePlacesCalls: number;
  braveSearchCalls: number;
  lambdaDurationMs: number;
  lambdaRequests: number;
  s3GetOrHeadOps: number;
  s3PutOrListOps: number;
  s3DeleteOps: number;
  cloudFrontRequests: number;
  cloudFrontEgressBytes: number;
  aiCostNanos: number;
  toolCostNanos: number;
  infraCostNanos: number;
  totalCostNanos: number;
  aiCostUsd: string;
  toolCostUsd: string;
  infraCostUsd: string;
  totalCostUsd: string;
}

export interface SpendTurnRecord {
  turnId: string;
  timestamp: string;
  operation: SpendOperation;
  status: TurnStatus;
  providerId?: string;
  modelId?: string;
  aiCalls: number;
  unmeteredAiCalls: number;
  stalePricedAiCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  googlePlacesCalls: number;
  braveSearchCalls: number;
  infra: InfraUsageMetrics;
  aiCostNanos: number;
  toolCostNanos: number;
  infraCostNanos: number;
  totalCostNanos: number;
  totalCostUsd: string;
}

export interface UserSpendLedger {
  schemaVersion: 1;
  userEmail: string;
  updatedAt: string;
  totals: SpendBreakdownBucket;
  byMonth: Record<string, SpendBreakdownBucket>;
  byDay: Record<string, SpendBreakdownBucket>;
  byModel: Record<string, SpendBreakdownBucket>;
  byOperation: Partial<Record<SpendOperation, SpendBreakdownBucket>>;
  recentTurns: SpendTurnRecord[];
}

export type SpendEnvironment = 'cloud' | 'local';

export interface SpendTurnContext {
  turnId: string;
  startedAt: number;
  environment: SpendEnvironment;
  operation: SpendOperation;
  email: string;
  addAiUsage(event: AiUsageEvent): void;
  addToolUsage(event: ToolUsageEvent): void;
  snapshotInfra(): InfraUsageMetrics;
}

export const MAX_RECENT_TURNS = 200;
export const MAX_LEDGER_BYTES = 2_000_000;
