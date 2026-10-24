import type {
  WaypointContext,
  CopilotAlert,
  GenerateAlertResult,
  BatchAlertResult,
  DayTitleContext,
  DayTitleResult,
  AiModelOption,
  ToolDeclaration,
  GenerateOptions,
  GenerateStreamWithToolsResult,
  AiStatusResult,
  AiEngineType,
} from '../types/ai.js';
import type { ScoutStreamEvent } from '../types/scout.js';
import {
  AwsBedrockHarnessAdapter,
  InvalidModelError,
  BEDROCK_MODEL_CATALOG,
} from './bedrockService.js';

import {
  buildSingleWaypointPrompt,
  buildBatchWaypointPrompt,
  buildDayTitlePrompt,
} from './promptBuilder.js';
import {
  parseCopilotAlert,
  parseBatchCopilotAlerts,
  generateTemplateAlert,
  parseModelOutput,
} from './schemaParser.js';

export type { AiStatusResult };
export { InvalidModelError, BEDROCK_MODEL_CATALOG };

/**
 * Pluggable AI Harness Adapter interface for LLM generation engines.
 */
export interface AiHarnessAdapter {
  readonly id: 'bedrock' | 'template' | string;
  readonly name: string;
  isAvailable(apiKey?: string): Promise<boolean>;
  generate(prompt: string, apiKeyOrOptions?: string | GenerateOptions): Promise<string>;
  decorateScoutPrompt?(domainPrompt: string): string;
  sanitizeResponse?(rawText: string): string;
  validateModelId?(modelId: string): string;
  getModelCatalog?(): {
    models: AiModelOption[];
    defaultScoutModelId: string;
    defaultCopywriterModelId: string;
  };
  getAvailableModels?(): Promise<AiModelOption[]>;
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
  bedrockAdapter?: AwsBedrockHarnessAdapter;
}

export interface GenerationOptions {
  apiKey?: string;
  modelId?: string;
  abortSignal?: AbortSignal;
  preferredEngine?: AiEngineType | 'auto';
}

export class AiService {
  private adapters: Map<string, AiHarnessAdapter> = new Map();

  constructor(options: AiServiceOptions = {}) {
    if (options.adapters && options.adapters.length > 0) {
      for (const adapter of options.adapters) {
        this.registerAdapter(adapter);
      }
    } else {
      const bedrockAdapter = options.bedrockAdapter || new AwsBedrockHarnessAdapter();
      this.registerAdapter(bedrockAdapter);
    }
  }

  registerAdapter(adapter: AiHarnessAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  getAdapter(id: string): AiHarnessAdapter | undefined {
    return this.adapters.get(id);
  }

  validateModelId(modelId?: string): string | undefined {
    if (modelId === undefined || modelId === null) {
      return undefined;
    }
    const bedrock = this.adapters.get('bedrock') as AwsBedrockHarnessAdapter | undefined;
    if (bedrock && typeof bedrock.validateModelId === 'function') {
      return bedrock.validateModelId(modelId);
    }
    return new AwsBedrockHarnessAdapter({ available: false }).validateModelId(modelId);
  }

  /**
   * Checks if Bedrock AI harness adapter is available and ready for generation.
   */
  async checkAvailability(apiKey?: string): Promise<boolean> {
    for (const adapter of this.adapters.values()) {
      try {
        if (await adapter.isAvailable(apiKey)) {
          return true;
        }
      } catch {
        // ignore
      }
    }
    return false;
  }

  /**
   * Returns a status object for AI feature readiness and model catalog.
   */
  async getStatus(apiKey?: string): Promise<AiStatusResult> {
    let activeAdapter: AiHarnessAdapter | undefined;

    for (const adapter of this.adapters.values()) {
      try {
        if (await adapter.isAvailable(apiKey)) {
          activeAdapter = adapter;
          break;
        }
      } catch {
        // ignore
      }
    }

    const isAvail = Boolean(activeAdapter);
    let catalog;
    const bedrock = (this.adapters.get('bedrock') || activeAdapter) as AwsBedrockHarnessAdapter | undefined;
    if (bedrock && typeof bedrock.getAvailableModels === 'function') {
      try {
        const models = await bedrock.getAvailableModels();
        catalog = {
          models,
          defaultScoutModelId: bedrock.defaultScoutModelId,
          defaultCopywriterModelId: bedrock.defaultCopywriterModelId,
        };
      } catch {
        if (typeof bedrock.getModelCatalog === 'function') {
          catalog = bedrock.getModelCatalog();
        }
      }
    } else if (bedrock && typeof bedrock.getModelCatalog === 'function') {
      catalog = bedrock.getModelCatalog();
    }

    return {
      available: isAvail,
      engine: activeAdapter ? (activeAdapter.id as AiEngineType) : undefined,
      ...(catalog ? catalog : {}),
      message: isAvail
        ? undefined
        : 'AI features are currently unavailable. AWS Bedrock is not accessible or not configured.',
    };
  }

  /**
   * Generates a single alert for a waypoint.
   * If preferredEngine is 'template', generates deterministic offline template alert.
   * Otherwise uses Bedrock; fails loudly if Bedrock invocation fails.
   */
  async generateAlert(
    waypoint: WaypointContext,
    options: GenerationOptions = {}
  ): Promise<GenerateAlertResult> {
    if (options.abortSignal?.aborted) {
      throw new Error('Request aborted');
    }

    const validatedModelId = this.validateModelId(options.modelId);
    const prompt = buildSingleWaypointPrompt(waypoint);
    const preferredEngine = options.preferredEngine || 'auto';

    if (preferredEngine === 'template') {
      const templateAlert = generateTemplateAlert(waypoint);
      return {
        alert: templateAlert,
        title: templateAlert.title,
        message: templateAlert.message,
        speech: templateAlert.speech,
        recommended_trigger_radius_miles: templateAlert.recommended_trigger_radius_miles,
        engine: 'template',
      };
    }

    const bedrock = this.adapters.get('bedrock');
    if (!bedrock) {
      throw new Error('Amazon Bedrock adapter is not registered');
    }

    const isAvail = await bedrock.isAvailable();
    if (!isAvail) {
      throw new Error('Amazon Bedrock is currently unavailable. Please verify AWS credentials and region.');
    }

    const rawOutput = await bedrock.generate(prompt, {
      modelId: validatedModelId,
      abortSignal: options.abortSignal,
    });
    const parsed = parseModelOutput(rawOutput);
    const alert = parseCopilotAlert(parsed, waypoint);
    return {
      alert,
      title: alert.title,
      message: alert.message,
      speech: alert.speech,
      recommended_trigger_radius_miles: alert.recommended_trigger_radius_miles,
      engine: 'bedrock',
    };
  }

  /**
   * Suggests a day title from the actual stops using Bedrock (or template if explicitly requested).
   * Fails loudly if Bedrock invocation fails.
   */
  async generateDayTitle(
    ctx: DayTitleContext,
    options: GenerationOptions = {}
  ): Promise<DayTitleResult> {
    if (options.abortSignal?.aborted) {
      throw new Error('Request aborted');
    }

    const validatedModelId = this.validateModelId(options.modelId);
    const preferredEngine = options.preferredEngine || 'auto';
    const prompt = buildDayTitlePrompt(ctx);

    if (preferredEngine === 'template') {
      const first = ctx.stops[0]?.name.split(',')[0] || 'Start';
      const last = ctx.stops[ctx.stops.length - 1]?.name.split(',')[0] || 'End';
      return { title: `${first} to ${last}`.slice(0, 60), engine: 'template' };
    }

    const bedrock = this.adapters.get('bedrock');
    if (!bedrock) {
      throw new Error('Amazon Bedrock adapter is not registered');
    }

    const isAvail = await bedrock.isAvailable();
    if (!isAvail) {
      throw new Error('Amazon Bedrock is currently unavailable. Please verify AWS credentials and region.');
    }

    const rawOutput = await bedrock.generate(prompt, {
      modelId: validatedModelId,
      abortSignal: options.abortSignal,
    });
    const parsed = parseModelOutput(rawOutput);
    const raw = parsed && typeof parsed === 'object' ? (parsed as { title?: unknown }).title : parsed;
    const title = typeof raw === 'string' ? raw.replace(/^day\s*\d+\s*[:\-–]\s*/i, '').trim() : '';
    if (!title) {
      throw new Error('Failed to generate day title from Bedrock response');
    }
    return { title: title.slice(0, 60), engine: 'bedrock' };
  }

  /**
   * Generates alerts for a batch of waypoints in a single invocation.
   * Fails loudly if Bedrock invocation fails.
   */
  async generateBatchAlerts(
    waypoints: WaypointContext[],
    options: GenerationOptions = {}
  ): Promise<BatchAlertResult> {
    if (options.abortSignal?.aborted) {
      throw new Error('Request aborted');
    }

    const validatedModelId = this.validateModelId(options.modelId);
    if (waypoints.length === 0) {
      return { alerts: {}, results: [], engine: 'template' };
    }

    const prompt = buildBatchWaypointPrompt(waypoints);
    const preferredEngine = options.preferredEngine || 'auto';

    if (preferredEngine === 'template') {
      return this.generateBatchTemplate(waypoints);
    }

    const bedrock = this.adapters.get('bedrock');
    if (!bedrock) {
      throw new Error('Amazon Bedrock adapter is not registered');
    }

    const isAvail = await bedrock.isAvailable();
    if (!isAvail) {
      throw new Error('Amazon Bedrock is currently unavailable. Please verify AWS credentials and region.');
    }

    const rawOutput = await bedrock.generate(prompt, {
      modelId: validatedModelId,
      abortSignal: options.abortSignal,
    });
    const parsed = parseModelOutput(rawOutput);
    const alerts = parseBatchCopilotAlerts(parsed, waypoints);
    const results = waypoints.map((wp) => ({
      id: wp.id,
      alert: alerts[wp.id],
    }));
    return { alerts, results, engine: 'bedrock' };
  }

  private generateBatchTemplate(waypoints: WaypointContext[]): BatchAlertResult {
    const alerts: Record<string, CopilotAlert> = {};
    const results: Array<{ id: string; alert: CopilotAlert }> = [];

    for (const wp of waypoints) {
      const alert = generateTemplateAlert(wp);
      alerts[wp.id] = alert;
      results.push({ id: wp.id, alert });
    }

    return { alerts, results, engine: 'template' };
  }
}

export const defaultAiService = new AiService();
