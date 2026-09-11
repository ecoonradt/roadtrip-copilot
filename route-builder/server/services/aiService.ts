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

export interface AiServiceOptions {
  execAgyFn?: (prompt: string) => Promise<string>;
  fetchCloudFn?: (prompt: string, apiKey: string) => Promise<string>;
  defaultApiKey?: string;
  defaultGeminiModel?: string;
}

export interface GenerationOptions {
  apiKey?: string;
  preferredEngine?: 'agy' | 'cloud' | 'template' | 'auto';
}

/**
 * Default child_process execution for agy CLI.
 */
async function defaultExecAgy(prompt: string): Promise<string> {
  const customPath = process.env.PATH ? `${process.env.HOME}/.local/bin:${process.env.PATH}` : '/usr/local/bin:/usr/bin:/bin';
  const { stdout } = await execFileAsync('agy', ['-p', prompt, '--output-format', 'json'], {
    timeout: 30000,
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

/**
 * Default fetch call to Google AI Studio Gemini API.
 */
async function defaultFetchCloud(
  prompt: string,
  apiKey: string,
  model = 'gemini-2.0-flash'
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

export class AiService {
  private execAgyFn: (prompt: string) => Promise<string>;
  private fetchCloudFn: (prompt: string, apiKey: string) => Promise<string>;
  private defaultApiKey?: string;
  public readonly defaultGeminiModel: string;

  constructor(options: AiServiceOptions = {}) {
    this.defaultGeminiModel = options.defaultGeminiModel || 'gemini-2.0-flash';
    this.execAgyFn = options.execAgyFn || defaultExecAgy;
    this.fetchCloudFn =
      options.fetchCloudFn ||
      ((prompt: string, key: string) =>
        defaultFetchCloud(prompt, key, this.defaultGeminiModel));
    this.defaultApiKey = options.defaultApiKey || process.env.GEMINI_API_KEY;
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

    // 1. Try Primary: agy CLI
    if (preferredEngine !== 'cloud') {
      try {
        const rawOutput = await this.execAgyFn(prompt);
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
      } catch (err: unknown) {
        // Fall through to cloud or template fallback
      }
    }

    // 2. Try Cloud Fallback if apiKey is available
    if (apiKey) {
      try {
        const rawOutput = await this.fetchCloudFn(prompt, apiKey);
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
      } catch (err: unknown) {
        // Fall through to template fallback
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

    // 1. Try Primary: agy CLI
    if (preferredEngine !== 'cloud') {
      try {
        const rawOutput = await this.execAgyFn(prompt);
        const parsed = parseModelOutput(rawOutput);
        const alerts = parseBatchCopilotAlerts(parsed, waypoints);
        const results = waypoints.map((wp) => ({
          id: wp.id,
          alert: alerts[wp.id],
        }));
        return { alerts, results, engine: 'agy' };
      } catch (err: unknown) {
        // Fall through to cloud or template fallback
      }
    }

    // 2. Try Cloud Fallback if apiKey is available
    if (apiKey) {
      try {
        const rawOutput = await this.fetchCloudFn(prompt, apiKey);
        const parsed = parseModelOutput(rawOutput);
        const alerts = parseBatchCopilotAlerts(parsed, waypoints);
        const results = waypoints.map((wp) => ({
          id: wp.id,
          alert: alerts[wp.id],
        }));
        return { alerts, results, engine: 'cloud' };
      } catch (err: unknown) {
        // Fall through to template fallback
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
