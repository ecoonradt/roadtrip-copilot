import type {
  WaypointContext,
  GenerateAlertResult,
  BatchAlertResult,
  DayTitleContext,
  DayTitleResult,
  AiModelOption,
  ToolDeclaration,
  GenerateOptions,
  GenerateStreamWithToolsResult,
  AiStatusResult,
} from '../types/ai.js';
import type { ScoutStreamEvent } from '../types/scout.js';
import {
  buildSingleWaypointPrompt,
  buildBatchWaypointPrompt,
  buildDayTitlePrompt,
} from './promptBuilder.js';
import {
  parseCopilotAlert,
  parseBatchCopilotAlerts,
  parseModelOutput,
  MalformedAiResponseError,
} from './schemaParser.js';

/** Raised when a caller requests a model the provider does not offer (HTTP 400). */
export class InvalidModelError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidModelError';
  }
}

/** Raised when a caller requests an AI provider that is not registered (HTTP 400). */
export class UnknownAiProviderError extends Error {
  readonly statusCode = 400;

  constructor(providerId: string) {
    super(`AI provider "${providerId}" is not registered`);
    this.name = 'UnknownAiProviderError';
  }
}

/**
 * Provider adapter contract for an AI backend.
 *
 * An adapter represents a *provider* (for example a multi-model cloud inference
 * service), not a single model. Providers expose a catalog of models at different
 * price/performance points; the studio selects a model id within the active
 * provider via `validateModelId` and the role defaults returned by
 * `getModelCatalog`.
 *
 * Implementations must fail loudly: never substitute canned/offline copy for a
 * provider failure.
 */
export interface AiHarnessAdapter {
  /** Stable provider identifier used by `preferredEngine` and response metadata. */
  readonly id: string;
  /** Human-readable provider name used in diagnostics. */
  readonly name: string;
  isAvailable(apiKey?: string): Promise<boolean>;
  generate(prompt: string, options?: GenerateOptions): Promise<string>;
  /** Normalizes a model id and throws when the provider does not offer it. */
  validateModelId(modelId: string): string;
  /** Account-verified models currently usable through this provider. */
  getAvailableModels(): Promise<AiModelOption[]>;
  /** Configured role defaults (used when the caller does not pin a model). */
  getModelCatalog(): {
    models: AiModelOption[];
    defaultScoutModelId: string;
    defaultCopywriterModelId: string;
  };
  /** Applies provider-specific harness directives to the pure domain prompt. */
  decorateScoutPrompt(domainPrompt: string): string;
  /** Removes provider-specific harness noise from driver-facing prose. */
  sanitizeResponse(rawText: string): string;
  /** Optional streaming/tool-loop capability. */
  generateStreamWithTools?(
    prompt: string,
    tools: ToolDeclaration[],
    dispatcher: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    onChunk: (event: ScoutStreamEvent) => void,
    options?: GenerateOptions
  ): Promise<GenerateStreamWithToolsResult>;
}

export interface AiServiceOptions {
  adapters?: AiHarnessAdapter[];
  /** Adapter used for `preferredEngine: 'auto'`; defaults to the first registered. */
  primaryAdapterId?: string;
}

export interface GenerationOptions {
  apiKey?: string;
  modelId?: string;
  abortSignal?: AbortSignal;
  preferredEngine?: string;
}

export class AiService {
  private adapters: Map<string, AiHarnessAdapter> = new Map();
  private primaryAdapterId?: string;

  constructor(options: AiServiceOptions = {}) {
    for (const adapter of options.adapters ?? []) {
      this.registerAdapter(adapter);
    }
    if (options.primaryAdapterId) {
      this.primaryAdapterId = options.primaryAdapterId;
    }
  }

  registerAdapter(adapter: AiHarnessAdapter): void {
    this.adapters.set(adapter.id, adapter);
    if (!this.primaryAdapterId) {
      this.primaryAdapterId = adapter.id;
    }
  }

  getAdapter(id: string): AiHarnessAdapter | undefined {
    return this.adapters.get(id);
  }

  getPrimaryAdapter(): AiHarnessAdapter | undefined {
    if (this.primaryAdapterId) {
      const primary = this.adapters.get(this.primaryAdapterId);
      if (primary) {
        return primary;
      }
    }
    return this.adapters.values().next().value;
  }

  /**
   * Resolves the provider adapter for a request. `'auto'`/undefined selects the
   * primary provider; any other value must name a registered adapter.
   */
  getAdapterFor(preferredEngine?: string): AiHarnessAdapter {
    if (preferredEngine && preferredEngine !== 'auto') {
      const adapter = this.adapters.get(preferredEngine);
      if (!adapter) {
        throw new UnknownAiProviderError(preferredEngine);
      }
      return adapter;
    }
    const adapter = this.getPrimaryAdapter();
    if (!adapter) {
      throw new Error('No AI provider adapter is registered');
    }
    return adapter;
  }

  validateModelId(modelId?: string, preferredEngine?: string): string | undefined {
    if (modelId === undefined || modelId === null) {
      return undefined;
    }
    return this.getAdapterFor(preferredEngine).validateModelId(modelId);
  }

  /**
   * Returns a status object for AI feature readiness and the provider model catalog.
   * Never falls back to an unverified static catalog.
   */
  async getStatus(apiKey?: string): Promise<AiStatusResult> {
    const adapter = this.getPrimaryAdapter();
    if (!adapter) {
      return {
        available: false,
        message: 'AI features are currently unavailable. No AI provider adapter is registered.',
      };
    }

    try {
      if (!(await adapter.isAvailable(apiKey))) {
        return {
          available: false,
          engine: adapter.id,
          providerName: adapter.name,
          message: `AI features are currently unavailable. ${adapter.name} is not accessible or not configured.`,
        };
      }

      const models = await adapter.getAvailableModels();
      if (models.length === 0) {
        return {
          available: false,
          engine: adapter.id,
          providerName: adapter.name,
          message: `AI features are currently unavailable. No ${adapter.name} models are accessible for this account.`,
        };
      }

      const catalog = adapter.getModelCatalog();
      return {
        available: true,
        engine: adapter.id,
        providerName: adapter.name,
        models,
        defaultScoutModelId: catalog.defaultScoutModelId,
        defaultCopywriterModelId: catalog.defaultCopywriterModelId,
      };
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        available: false,
        engine: adapter.id,
        providerName: adapter.name,
        message: `${adapter.name} model availability check failed: ${detail}`,
      };
    }
  }

  /**
   * Generates a single alert for a waypoint via the resolved provider.
   * Fails loudly if the provider is unavailable or returns an unusable payload.
   */
  async generateAlert(
    waypoint: WaypointContext,
    options: GenerationOptions = {}
  ): Promise<GenerateAlertResult> {
    if (options.abortSignal?.aborted) {
      throw new Error('Request aborted');
    }

    const adapter = this.getAdapterFor(options.preferredEngine);
    const validatedModelId = this.validateModelId(options.modelId, options.preferredEngine);
    const prompt = buildSingleWaypointPrompt(waypoint);

    if (!(await adapter.isAvailable(options.apiKey))) {
      throw new Error(`${adapter.name} is currently unavailable.`);
    }

    const rawOutput = await adapter.generate(prompt, {
      modelId: validatedModelId,
      abortSignal: options.abortSignal,
    });
    const parsed = parseModelOutput(rawOutput);
    const alert = parseCopilotAlert(parsed);
    return {
      alert,
      title: alert.title,
      message: alert.message,
      speech: alert.speech,
      recommended_trigger_radius_miles: alert.recommended_trigger_radius_miles,
      engine: adapter.id,
    };
  }

  /**
   * Suggests a day title from the actual stops using the resolved provider.
   * Fails loudly if the provider invocation fails.
   */
  async generateDayTitle(
    ctx: DayTitleContext,
    options: GenerationOptions = {}
  ): Promise<DayTitleResult> {
    if (options.abortSignal?.aborted) {
      throw new Error('Request aborted');
    }

    const adapter = this.getAdapterFor(options.preferredEngine);
    const validatedModelId = this.validateModelId(options.modelId, options.preferredEngine);
    const prompt = buildDayTitlePrompt(ctx);

    if (!(await adapter.isAvailable(options.apiKey))) {
      throw new Error(`${adapter.name} is currently unavailable.`);
    }

    const rawOutput = await adapter.generate(prompt, {
      modelId: validatedModelId,
      abortSignal: options.abortSignal,
    });
    const parsed = parseModelOutput(rawOutput);
    const raw = parsed && typeof parsed === 'object' ? (parsed as { title?: unknown }).title : parsed;
    const title = typeof raw === 'string' ? raw.replace(/^day\s*\d+\s*[:\-–]\s*/i, '').trim() : '';
    if (!title) {
      throw new MalformedAiResponseError('AI provider returned an unusable day-title payload');
    }
    return { title: title.slice(0, 60), engine: adapter.id };
  }

  /**
   * Generates alerts for a batch of waypoints in a single provider invocation.
   * Fails loudly if the provider invocation fails or omits a waypoint.
   */
  async generateBatchAlerts(
    waypoints: WaypointContext[],
    options: GenerationOptions = {}
  ): Promise<BatchAlertResult> {
    if (options.abortSignal?.aborted) {
      throw new Error('Request aborted');
    }

    if (waypoints.length === 0) {
      return { alerts: {}, results: [] };
    }

    const adapter = this.getAdapterFor(options.preferredEngine);
    const validatedModelId = this.validateModelId(options.modelId, options.preferredEngine);
    const prompt = buildBatchWaypointPrompt(waypoints);

    if (!(await adapter.isAvailable(options.apiKey))) {
      throw new Error(`${adapter.name} is currently unavailable.`);
    }

    const rawOutput = await adapter.generate(prompt, {
      modelId: validatedModelId,
      abortSignal: options.abortSignal,
    });
    const parsed = parseModelOutput(rawOutput);
    const alerts = parseBatchCopilotAlerts(parsed, waypoints);
    const results = waypoints.map((wp) => ({
      id: wp.id,
      alert: alerts[wp.id],
    }));
    return { alerts, results, engine: adapter.id };
  }
}
