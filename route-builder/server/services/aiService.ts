import { execFile, spawn } from 'node:child_process';
import readline from 'node:readline';
import { promisify } from 'node:util';
import type {
  WaypointContext,
  CopilotAlert,
  GenerateAlertResult,
  BatchAlertResult,
} from '../types/ai.js';
import type { ScoutActivity } from '../types/scout.js';

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
  decorateScoutPrompt?(domainPrompt: string): string;
  sanitizeResponse?(rawText: string): string;
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
  const args = ['-p', prompt, '--output-format', 'json', '--print-timeout', '10m'];
  if (model) {
    args.push('--model', model);
  }

  const { stdout } = await execFileAsync('agy', args, {
    timeout: 600000,
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

export interface AgyStreamEvent {
  type: 'thought' | 'delta' | 'activity';
  text: string;
  activity?: ScoutActivity;
}

/**
 * Formats raw tool calls and steps from agy's stream-json into user-friendly, abstracted activity descriptions.
 */
export function formatAgyActivity(su: {
  step_index?: number;
  state?: string;
  tool_name?: string;
  tool_info?: {
    name?: string;
    parameters?: Record<string, unknown>;
    output?: unknown;
  };
  duration_seconds?: number;
  text_delta?: string;
}): ScoutActivity {
  const toolName = su.tool_name || su.tool_info?.name || 'tool';
  const params = su.tool_info?.parameters || {};
  const isDone = su.state === 'DONE';
  const state: 'active' | 'done' | 'error' = su.state === 'ERROR' ? 'error' : isDone ? 'done' : 'active';
  const id = `step_${su.step_index ?? Date.now()}_${toolName}`;
  const durationSeconds = su.duration_seconds;

  if (toolName === 'search_web') {
    const query = typeof params.query === 'string' ? params.query.trim() : '';
    const label = query ? `Searching web: "${query}"` : 'Searching the web...';
    return { id, type: 'search', label, state, durationSeconds };
  }

  if (toolName === 'read_url_content') {
    const rawUrl = typeof params.Url === 'string' ? params.Url : '';
    let host = rawUrl;
    try {
      if (rawUrl) host = new URL(rawUrl).hostname.replace(/^www\./, '');
    } catch {
      // ignore
    }
    const label = host ? `Reading content from ${host}` : 'Reading web content...';
    return { id, type: 'tool', label, detail: rawUrl, state, durationSeconds };
  }

  if (toolName === 'run_command') {
    const cmd = typeof params.CommandLine === 'string' ? params.CommandLine.trim() : '';
    let label = 'Executing command';
    if (cmd.startsWith('curl')) {
      label = 'Querying network endpoint via curl';
    } else if (cmd.includes('python')) {
      label = 'Calculating route geometry via Python';
    } else if (cmd) {
      const truncated = cmd.length > 40 ? `${cmd.substring(0, 37)}...` : cmd;
      label = `Running: ${truncated}`;
    }
    return { id, type: 'command', label, detail: cmd, state, durationSeconds };
  }

  if (toolName === 'view_file' || toolName === 'grep_search' || toolName === 'find_by_name') {
    return { id, type: 'tool', label: 'Inspecting itinerary files', state, durationSeconds };
  }

  const cleanName = toolName.replace(/_/g, ' ');
  const label = isDone ? `Completed ${cleanName}` : `Running ${cleanName}...`;
  return { id, type: 'tool', label, state, durationSeconds };
}

/**
 * Child process streaming execution for agy CLI using NDJSON stream-json output.
 */
export async function defaultStreamExecAgy(
  prompt: string,
  onChunk: (event: AgyStreamEvent) => void
): Promise<string> {
  const customPath = `${process.env.HOME || '/home/eric'}/.local/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`;
  const model = await resolveLatestAgyFlashModel();
  const args = ['-p', prompt, '--output-format', 'stream-json', '--print-timeout', '10m'];
  if (model) {
    args.push('--model', model);
  }

  return new Promise<string>((resolve, reject) => {
    const child = spawn('agy', args, {
      env: {
        ...process.env,
        PATH: customPath,
      },
    });

    let fullResponse = '';
    let accumulatedDelta = '';
    let stderrOutput = '';
    let isDone = false;
    const rl = readline.createInterface({ input: child.stdout });

    // Trust OS process liveness and agy's internal lifecycle rather than fighting arbitrary
    // inactivity timeouts. We provide an extended 10-minute safety ceiling.
    const MAX_TOTAL_MS = 600000;

    const maxTimer = setTimeout(() => {
      if (!isDone) {
        isDone = true;
        child.kill('SIGTERM');
        reject(new Error('Route Scout stream execution timed out after 600s'));
      }
    }, MAX_TOTAL_MS);

    const cleanup = () => {
      clearTimeout(maxTimer);
    };

    child.stderr.on('data', (chunk) => {
      stderrOutput += chunk.toString();
    });

    rl.on('line', (line) => {
      try {
        const data = JSON.parse(line.trim());
        if (data.event === 'step_update' && data.step_update) {
          const su = data.step_update;
          if (su.step_type === 'agent_response' && su.text_delta) {
            accumulatedDelta += su.text_delta;
            onChunk({ type: 'delta', text: su.text_delta });
          } else if (
            su.step_type === 'tool' ||
            su.step_type === 'tool_use' ||
            su.step_type === 'tool_call'
          ) {
            const activity = formatAgyActivity(su);
            onChunk({ type: 'activity', text: activity.label, activity });
            onChunk({ type: 'thought', text: activity.label });
          } else if (
            su.step_type === 'thought' ||
            (su.step_type === 'agent_response' && !su.text_delta && su.thought)
          ) {
            const thoughtText = su.text_delta || su.thought || 'Analyzing route corridor...';
            const activity: ScoutActivity = {
              id: `thought_${su.step_index ?? Date.now()}`,
              type: 'thought',
              label: thoughtText,
              state: su.state === 'DONE' ? 'done' : 'active',
              durationSeconds: su.duration_seconds,
            };
            onChunk({ type: 'activity', text: thoughtText, activity });
            onChunk({ type: 'thought', text: thoughtText });
          }
        } else if (data.event === 'result' && data.result) {
          if (data.result.response && typeof data.result.response === 'string') {
            fullResponse = data.result.response;
          }
        }
      } catch {
        // ignore non-json lines
      }
    });

    child.on('close', (code) => {
      isDone = true;
      cleanup();
      const finalResult = fullResponse || accumulatedDelta;
      if (code !== 0 && !finalResult) {
        const detail = stderrOutput.trim() || `agy process exited with code ${code}`;
        reject(new Error(detail));
      } else {
        resolve(finalResult);
      }
    });

    child.on('error', (err) => {
      isDone = true;
      cleanup();
      reject(err);
    });
  });
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

  async generateStream(
    prompt: string,
    onChunk: (event: AgyStreamEvent) => void
  ): Promise<string> {
    return defaultStreamExecAgy(prompt, onChunk);
  }

  /**
   * Decorates the domain prompt with Antigravity-specific operational instructions and tool permissions.
   */
  decorateScoutPrompt(domainPrompt: string): string {
    return `CRITICAL OPERATIONAL HARNESS DIRECTIVES:
1. You are Route Scout, an expert scenic road-trip co-pilot and navigator embedded in the Roadtrip Co-Pilot Route Builder studio.
2. You MAY invoke \`search_web\`, \`read_url_content\`, and \`run_command\` (for curl network checks, python coordinate math, or quick data inspection) to verify real-world place names, highway exits, amenities, closures, and accurate GPS coordinates.
3. ABSOLUTE TOOL BUDGET: You have a strict budget of at most 2 tool calls for this entire turn. After at most 2 tool calls, you MUST formulate your response and output your candidate suggestions immediately. Never run loops, multi-coordinate reverse geocodes, bulk scraping chains, or iterative scripts.
4. FAST SYNTHESIS: Answer the driver's question directly with practical highway road-trip knowledge. Do NOT attempt to calculate millimetric precision or run continuous API trials when the general highway corridor or town location is already established.
5. DO NOT launch background tasks, cron schedules, subagents, or browser automation. Never write or modify workspace files.
6. Respond directly, naturally, and warmly to the driver like a knowledgeable passenger sitting in the vehicle.
7. NEVER include meta-commentary about system tools, agent harnesses, or background tasks (e.g. NEVER say "Wait for the background task to complete" or "Querying coordinates").
8. NEVER narrate UI mechanics or JSON blocks in your prose (e.g. do not say "I have framed this as a candidate update below", "I have attached the JSON below", or "See the card below"). Simply explain your recommendation naturally.
9. Provide accurate, real-world coordinates on the road corridor for all candidate suggestions.

${domainPrompt}`;
  }

  /**
   * Cleans internal Antigravity agent harness noise, background task text, and meta-commentary from responses.
   */
  static sanitizeAgyResponse(rawText: string): string {
    if (!rawText) return '';
    let cleaned = rawText.trim();

    // 1. Strip leading harness noise (e.g. "Wait for the background task to complete.", "Waiting for task...")
    const leadingHarnessRegex = /^(?:Wait for the (?:background )?task to complete\.?|Waiting for (?:background )?task\.?|Wait for the command to finish\.?|Let me inspect[^.\n]*\.\s*)\s*/gi;
    cleaned = cleaned.replace(leadingHarnessRegex, '').trim();

    // 2. Strip trailing meta-commentary where the model narrates cards or JSON to the harness
    const trailingHarnessRegex = /\n+(?:I have (?:framed|attached|included|provided|appended|added) this as a candidate (?:update|stop|suggestion)[^\n]*|I have (?:appended|included|generated|provided) the (?:JSON|structured|candidate)[^\n]*|See the candidate (?:card|update|suggestion) below[^\n]*)\.?\s*$/gi;
    cleaned = cleaned.replace(trailingHarnessRegex, '').trim();

    return cleaned;
  }

  sanitizeResponse(rawText: string): string {
    return AgyHarnessAdapter.sanitizeAgyResponse(rawText);
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

  decorateScoutPrompt(domainPrompt: string): string {
    return domainPrompt;
  }

  sanitizeResponse(rawText: string): string {
    return rawText.trim();
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
