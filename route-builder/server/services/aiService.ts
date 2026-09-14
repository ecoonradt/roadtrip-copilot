import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  WaypointContext,
  CopilotAlert,
  GenerateAlertResult,
  BatchAlertResult,
} from '../types/ai.js';

import {
  buildSingleWaypointPrompt,
  buildBatchWaypointPrompt,
} from './promptBuilder.js';
import {
  parseCopilotAlert,
  parseBatchCopilotAlerts,
  generateTemplateAlert,
  parseModelOutput,
} from './schemaParser.js';

const execFileAsync = promisify(execFile);

/**
 * Pluggable AI Harness Adapter interface for LLM generation engines.
 */
export interface AiHarnessAdapter {
  readonly id: 'agy' | 'cloud' | 'template' | string;
  readonly name: string;
  isAvailable(apiKey?: string): Promise<boolean>;
  generate(prompt: string, apiKey?: string): Promise<string>;
}

export interface AiServiceOptions {
  adapters?: AiHarnessAdapter[];
  execAgyFn?: (prompt: string) => Promise<string>;
  fetchCloudFn?: (prompt: string, apiKey: string) => Promise<string>;
  defaultApiKey?: string;
  defaultGeminiModel?: string;
}

export interface GenerationOptions {
  apiKey?: string;
  preferredEngine?: 'agy' | 'cloud' | 'template' | 'auto';
}

let cachedAgyFlashModel: string | null = null;

/**
 * Resets the in-memory cached agy Flash model (used in tests).
 */
export function resetAgyFlashModelCache(): void {
  cachedAgyFlashModel = null;
}

/**
 * Dynamically resolves the latest available Flash model from `agy models`.
 * If process.env.AGY_MODEL is set, that takes precedence.
 */
export async function resolveLatestAgyFlashModel(): Promise<string | null> {
  if (process.env.AGY_MODEL) {
    return process.env.AGY_MODEL;
  }
  if (cachedAgyFlashModel) {
    return cachedAgyFlashModel;
  }
  try {
    const customPath = `${process.env.HOME || '/home/eric'}/.local/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`;
    const { stdout } = await execFileAsync('agy', ['models'], {
      timeout: 10000,
      env: { ...process.env, PATH: customPath },
    });
    const lines = stdout.split('\n');
    for (const line of lines) {
      const match = line.trim().match(/^([a-zA-Z0-9._-]+flash[a-zA-Z0-9._-]*)/i);
      if (match && match[1]) {
        cachedAgyFlashModel = match[1];
        return cachedAgyFlashModel;
      }
    }
  } catch {
    // If agy models fails or times out, fallback to null (runs agy without explicit --model)
  }
  return null;
}

/**
 * Default child_process execution for agy CLI, passing the dynamically resolved Flash model.
 */
export async function defaultExecAgy(prompt: string): Promise<string> {
  const customPath = `${process.env.HOME || '/home/eric'}/.local/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`;

  const model = await resolveLatestAgyFlashModel();
  const args = ['-p', prompt, '--output-format', 'json'];
  if (model) {
    args.push('--model', model);
  }

  const { stdout } = await execFileAsync('agy', args, {
    timeout: 60000,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: customPath,
    },
  });

  const rawJson = stdout.trim();
  try {
    const envelope = JSON.parse(rawJson) as { status?: string; response?: string };
    if (envelope.response && typeof envelope.response === 'string') {
      return envelope.response;
    }
  } catch {
    // If not JSON envelope, return raw stdout
  }
  return rawJson;
}

export const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

/**
 * Default fetch call to Google AI Studio Gemini API.
 */
export async function defaultFetchCloud(
  prompt: string,
  apiKey: string,
  model = DEFAULT_GEMINI_MODEL
): Promise<string> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.7,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Google AI Studio API error (${response.status}): ${errText}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('No candidate content returned from Google AI Studio API');
  }

  return text;
}

/**
 * Antigravity CLI Harness Adapter.
 */
export class AgyHarnessAdapter implements AiHarnessAdapter {
  readonly id = 'agy';
  readonly name = 'Antigravity CLI (agy)';
  private execFn: (prompt: string) => Promise<string>;

  constructor(execFn: (prompt: string) => Promise<string> = defaultExecAgy) {
    this.execFn = execFn;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const model = await resolveLatestAgyFlashModel();
      return model !== null;
    } catch {
      return false;
    }
  }

  async generate(prompt: string): Promise<string> {
    return this.execFn(prompt);
  }
}

/**
 * Google AI Studio Harness Adapter (Gemini API).
 */
export class GeminiStudioHarnessAdapter implements AiHarnessAdapter {
  readonly id = 'cloud';
  readonly name = 'Google AI Studio (Gemini)';
  private fetchFn: (prompt: string, apiKey: string) => Promise<string>;
  public readonly model: string;

  constructor(
    fetchFn: (prompt: string, apiKey: string) => Promise<string> = defaultFetchCloud,
    model = DEFAULT_GEMINI_MODEL
  ) {
    this.fetchFn = fetchFn;
    this.model = model;
  }

  async isAvailable(apiKey?: string): Promise<boolean> {
    return Boolean(apiKey);
  }

  async generate(prompt: string, apiKey?: string): Promise<string> {
    if (!apiKey) {
      throw new Error('API key is required for Google AI Studio');
    }
    return this.fetchFn(prompt, apiKey);
  }
}

export class AiService {
  private adapters: Map<string, AiHarnessAdapter> = new Map();
  private defaultApiKey?: string;
  public readonly defaultGeminiModel: string;

  constructor(options: AiServiceOptions = {}) {
    this.defaultGeminiModel = options.defaultGeminiModel || DEFAULT_GEMINI_MODEL;
    this.defaultApiKey = options.defaultApiKey || process.env.GEMINI_API_KEY;

    if (options.adapters && options.adapters.length > 0) {
      for (const adapter of options.adapters) {
        this.registerAdapter(adapter);
      }
    } else {
      const agyAdapter = new AgyHarnessAdapter(options.execAgyFn || defaultExecAgy);
      const cloudAdapter = new GeminiStudioHarnessAdapter(
        options.fetchCloudFn ||
          ((prompt: string, key: string) =>
            defaultFetchCloud(prompt, key, this.defaultGeminiModel)),
        this.defaultGeminiModel
      );
      this.registerAdapter(agyAdapter);
      this.registerAdapter(cloudAdapter);
    }
  }

  registerAdapter(adapter: AiHarnessAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  getAdapter(id: string): AiHarnessAdapter | undefined {
    return this.adapters.get(id);
  }

  /**
   * Generates a single alert for a waypoint.
   */
  async generateAlert(
    waypoint: WaypointContext,
    options: GenerationOptions = {}
  ): Promise<GenerateAlertResult> {
    const apiKey = options.apiKey || this.defaultApiKey;
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

    // 1. Try Primary: agy harness adapter
    if (preferredEngine !== 'cloud') {
      const agy = this.adapters.get('agy');
      if (agy) {
        try {
          const rawOutput = await agy.generate(prompt);
          const parsed = parseModelOutput(rawOutput);
          const alert = parseCopilotAlert(parsed, waypoint);
          return {
            alert,
            title: alert.title,
            message: alert.message,
            speech: alert.speech,
            recommended_trigger_radius_miles: alert.recommended_trigger_radius_miles,
            engine: 'agy',
          };
        } catch {
          // Fall through to cloud or template fallback
        }
      }
    }

    // 2. Try Cloud Fallback if apiKey is available
    if (apiKey) {
      const cloud = this.adapters.get('cloud');
      if (cloud) {
        try {
          const rawOutput = await cloud.generate(prompt, apiKey);
          const parsed = parseModelOutput(rawOutput);
          const alert = parseCopilotAlert(parsed, waypoint);
          return {
            alert,
            title: alert.title,
            message: alert.message,
            speech: alert.speech,
            recommended_trigger_radius_miles: alert.recommended_trigger_radius_miles,
            engine: 'cloud',
          };
        } catch {
          // Fall through to template fallback
        }
      }
    }

    // 3. Deterministic Template Fallback (offline resilience)
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

  /**
   * Generates alerts for a batch of waypoints in a single invocation.
   */
  async generateBatchAlerts(
    waypoints: WaypointContext[],
    options: GenerationOptions = {}
  ): Promise<BatchAlertResult> {
    if (waypoints.length === 0) {
      return { alerts: {}, results: [], engine: 'template' };
    }

    const apiKey = options.apiKey || this.defaultApiKey;
    const prompt = buildBatchWaypointPrompt(waypoints);
    const preferredEngine = options.preferredEngine || 'auto';

    if (preferredEngine === 'template') {
      return this.generateBatchTemplate(waypoints);
    }

    // 1. Try Primary: agy harness adapter
    if (preferredEngine !== 'cloud') {
      const agy = this.adapters.get('agy');
      if (agy) {
        try {
          const rawOutput = await agy.generate(prompt);
          const parsed = parseModelOutput(rawOutput);
          const alerts = parseBatchCopilotAlerts(parsed, waypoints);
          const results = waypoints.map((wp) => ({
            id: wp.id,
            alert: alerts[wp.id],
          }));
          return { alerts, results, engine: 'agy' };
        } catch {
          // Fall through to cloud or template fallback
        }
      }
    }

    // 2. Try Cloud Fallback if apiKey is available
    if (apiKey) {
      const cloud = this.adapters.get('cloud');
      if (cloud) {
        try {
          const rawOutput = await cloud.generate(prompt, apiKey);
          const parsed = parseModelOutput(rawOutput);
          const alerts = parseBatchCopilotAlerts(parsed, waypoints);
          const results = waypoints.map((wp) => ({
            id: wp.id,
            alert: alerts[wp.id],
          }));
          return { alerts, results, engine: 'cloud' };
        } catch {
          // Fall through to template fallback
        }
      }
    }

    // 3. Deterministic Template Fallback
    return this.generateBatchTemplate(waypoints);
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
