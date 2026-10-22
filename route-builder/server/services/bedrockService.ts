import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type Message,
  type ContentBlock,
  type ToolConfiguration,
  type ToolResultStatus,
} from '@aws-sdk/client-bedrock-runtime';
import type { DocumentType } from '@smithy/types';
import type {
  AiModelOption,
  ToolDeclaration,
  GenerateOptions,
  GenerateStreamWithToolsResult,
} from '../types/ai.js';
import type { ScoutStreamEvent } from '../types/scout.js';
import type { AiHarnessAdapter } from './aiService.js';

export const DEFAULT_BEDROCK_SCOUT_MODEL_ID = 'us.moonshotai.kimi-k3';
export const DEFAULT_BEDROCK_COPYWRITER_MODEL_ID = 'us.amazon.nova-2-lite-v1:0';
export const MAX_TOOL_ITERATIONS = 5;

export const BEDROCK_MODEL_CATALOG: AiModelOption[] = [
  {
    id: 'us.moonshotai.kimi-k3',
    name: 'Moonshot Kimi K3',
    provider: 'Moonshot AI',
    description: 'Flagship 2.8T MoE corridor & agentic reasoning engine (1M context)',
    role: 'both',
  },
  {
    id: 'us.amazon.nova-2-lite-v1:0',
    name: 'Amazon Nova 2 Lite',
    provider: 'Amazon',
    description: 'Fast, low-latency reasoning & alert copywriter',
    role: 'both',
  },
  {
    id: 'us.amazon.nova-pro-v1:0',
    name: 'Amazon Nova Pro',
    provider: 'Amazon',
    description: 'Balanced multimodal & agentic route co-pilot',
    role: 'both',
  },
  {
    id: 'openai.gpt-oss-120b-1:0',
    name: 'OpenAI GPT-OSS 120B',
    provider: 'OpenAI',
    description: 'Frontier open-weights deep reasoning & tool-use model',
    role: 'both',
  },
  {
    id: 'openai.gpt-oss-20b-1:0',
    name: 'OpenAI GPT-OSS 20B',
    provider: 'OpenAI',
    description: 'High-speed, low-cost alert copywriting & chat',
    role: 'both',
  },
  {
    id: 'deepseek.v3.2',
    name: 'DeepSeek V3.2',
    provider: 'DeepSeek',
    description: 'High-efficiency corridor analysis & structured JSON generation',
    role: 'both',
  },
  {
    id: 'mistral.mistral-large-3-675b-instruct',
    name: 'Mistral Large 3 (675B)',
    provider: 'Mistral AI',
    description: 'Heavyweight 675B instruct model for multi-stop auditing',
    role: 'both',
  },
  {
    id: 'moonshotai.kimi-k2.5',
    name: 'Moonshot Kimi K2.5',
    provider: 'Moonshot AI',
    description: 'Fast on-demand conversational & tool-use model',
    role: 'both',
  },
  {
    id: 'us.openai.gpt-6-luna',
    name: 'OpenAI GPT-6 Luna',
    provider: 'OpenAI',
    description: 'Ultra-fast frontier model for copywriting & daily turns (requires AWS account opt-in)',
    role: 'both',
  },
  {
    id: 'us.anthropic.claude-sonnet-5-5',
    name: 'Anthropic Claude Sonnet 5.5',
    provider: 'Anthropic',
    description: 'Frontier agentic tool use & stylist (requires Anthropic account opt-in)',
    role: 'both',
  },
  {
    id: 'us.openai.gpt-6-sol',
    name: 'OpenAI GPT-6 Sol',
    provider: 'OpenAI',
    description: 'Standard frontier co-pilot & corridor logistics (requires AWS account opt-in)',
    role: 'both',
  },
  {
    id: 'us.openai.gpt-6-astra',
    name: 'OpenAI GPT-6 Astra',
    provider: 'OpenAI',
    description: 'Heavyweight multi-day corridor audit engine (requires AWS account opt-in)',
    role: 'scout',
  },
  {
    id: 'us.anthropic.claude-opus-5-5',
    name: 'Anthropic Claude Opus 5.5',
    provider: 'Anthropic',
    description: 'Flagship multi-day architect (requires Anthropic account opt-in)',
    role: 'scout',
  },
  {
    id: 'us.xai.grok-4.7',
    name: 'xAI Grok 4.7',
    provider: 'xAI',
    description: 'Long-horizon agentic workflow engine (requires AWS account opt-in)',
    role: 'both',
  },
];

export const INFERENCE_PROFILE_ALIASES: Record<string, string> = {
  'moonshotai.kimi-k3': 'us.moonshotai.kimi-k3',
  'amazon.nova-2-lite-v1:0': 'us.amazon.nova-2-lite-v1:0',
  'amazon.nova-pro-v1:0': 'us.amazon.nova-pro-v1:0',
  'openai.gpt-6-luna': 'us.openai.gpt-6-luna',
  'openai.gpt-6-sol': 'us.openai.gpt-6-sol',
  'openai.gpt-6.1-sol': 'us.openai.gpt-6.1-sol',
  'openai.gpt-6-astra': 'us.openai.gpt-6-astra',
  'anthropic.claude-sonnet-5-5': 'us.anthropic.claude-sonnet-5-5',
  'anthropic.claude-opus-5-5': 'us.anthropic.claude-opus-5-5',
  'anthropic.claude-sonnet-4-6': 'us.anthropic.claude-sonnet-4-6',
  'anthropic.claude-haiku-4-5-20251001-v1:0': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'xai.grok-4.7': 'us.xai.grok-4.7',
};

export const ADDITIONAL_ALLOWED_MODEL_IDS = new Set<string>([
  'amazon.nova-lite-v1:0',
  'us.amazon.nova-lite-v1:0',
  'us.openai.gpt-6.1-sol',
  'us.anthropic.claude-sonnet-4-6',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'deepseek.v3-v1:0',
  'meta.llama3-3-70b-instruct-v1:0',
  'us.meta.llama4-maverick-17b-instruct-v1:0',
]);

export class InvalidModelError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidModelError';
  }
}

export interface BedrockAdapterOptions {
  client?: BedrockRuntimeClient;
  region?: string;
  scoutModelId?: string;
  copywriterModelId?: string;
  available?: boolean;
}

export function sanitizeBedrockResponse(rawText: string): string {
  if (!rawText) return '';
  let cleaned = rawText;

  // 1. Strip closed <thinking>...</thinking> or <think>...</think> (case-insensitive)
  cleaned = cleaned.replace(/<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>/gi, '');

  // 2. Strip unclosed trailing <thinking>... or <think>... (case-insensitive)
  cleaned = cleaned.replace(/<(?:thinking|think)>[\s\S]*$/i, '');

  // 3. Strip leading harness noise
  cleaned = cleaned.replace(
    /^(?:Wait for the (?:background )?task to complete\.?|Waiting for (?:background )?task\.?|Wait for the command to finish\.?|Let me inspect[^.\n]*\.\s*)\s*/gi,
    ''
  );

  // 4. Strip trailing meta-commentary narrating cards or JSON
  cleaned = cleaned.replace(
    /\n+(?:I have (?:framed|attached|included|provided|appended|added) this as a candidate (?:update|stop|suggestion)[^\n]*|I have (?:appended|included|generated|provided) the (?:JSON|structured|candidate)[^\n]*|See the candidate (?:card|update|suggestion) below[^\n]*)\.?\s*$/gi,
    ''
  );

  return cleaned.trim();
}

export function formatBedrockToolLabel(
  name: string,
  input: Record<string, unknown>,
  isDone: boolean
): string {
  if (name === 'search_web') {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    return isDone
      ? query ? `Searched web for "${query}"` : 'Completed web search'
      : query ? `Searching web: "${query}"` : 'Searching the web...';
  }

  if (name === 'read_url_content') {
    const rawUrl = typeof input.Url === 'string' ? input.Url : typeof input.url === 'string' ? input.url : '';
    let host = rawUrl;
    try {
      if (rawUrl) host = new URL(rawUrl).hostname.replace(/^www\./, '');
    } catch {
      // ignore
    }
    return isDone
      ? host ? `Read content from ${host}` : 'Completed reading web content'
      : host ? `Reading content from ${host}` : 'Reading web content...';
  }

  const cleanName = name.replace(/_/g, ' ');
  return isDone ? `Completed ${cleanName}` : `Running ${cleanName}...`;
}

export class AwsBedrockHarnessAdapter implements AiHarnessAdapter {
  readonly id = 'bedrock';
  readonly name = 'Amazon Bedrock';
  public readonly defaultScoutModelId: string;
  public readonly defaultCopywriterModelId: string;
  private client: BedrockRuntimeClient;
  private hasCustomClient: boolean;
  private options: BedrockAdapterOptions;

  constructor(options: BedrockAdapterOptions = {}) {
    this.options = options;
    const region = options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    this.client = options.client ?? new BedrockRuntimeClient(region ? { region } : {});
    this.hasCustomClient = Boolean(options.client);

    const rawScout = options.scoutModelId || process.env.BEDROCK_SCOUT_MODEL_ID || DEFAULT_BEDROCK_SCOUT_MODEL_ID;
    this.defaultScoutModelId = INFERENCE_PROFILE_ALIASES[rawScout.trim()] || rawScout.trim();

    const rawCopywriter = options.copywriterModelId || process.env.BEDROCK_COPYWRITER_MODEL_ID || DEFAULT_BEDROCK_COPYWRITER_MODEL_ID;
    this.defaultCopywriterModelId = INFERENCE_PROFILE_ALIASES[rawCopywriter.trim()] || rawCopywriter.trim();
  }

  validateModelId(modelId: string): string {
    if (typeof modelId !== 'string') {
      throw new InvalidModelError('Model ID must not be empty');
    }
    const trimmed = modelId.trim();
    if (!trimmed) {
      throw new InvalidModelError('Model ID must not be empty');
    }
    const normalized = INFERENCE_PROFILE_ALIASES[trimmed] || trimmed;
    const isCatalog = BEDROCK_MODEL_CATALOG.some((m) => m.id === normalized);
    const isAdditional = ADDITIONAL_ALLOWED_MODEL_IDS.has(normalized);
    const isConfiguredDefault =
      normalized === this.defaultScoutModelId ||
      normalized === this.defaultCopywriterModelId;
    const envScout = process.env.BEDROCK_SCOUT_MODEL_ID
      ? (INFERENCE_PROFILE_ALIASES[process.env.BEDROCK_SCOUT_MODEL_ID.trim()] || process.env.BEDROCK_SCOUT_MODEL_ID.trim())
      : undefined;
    const envCopywriter = process.env.BEDROCK_COPYWRITER_MODEL_ID
      ? (INFERENCE_PROFILE_ALIASES[process.env.BEDROCK_COPYWRITER_MODEL_ID.trim()] || process.env.BEDROCK_COPYWRITER_MODEL_ID.trim())
      : undefined;
    const isEnv = normalized === envScout || normalized === envCopywriter;

    if (!isCatalog && !isAdditional && !isConfiguredDefault && !isEnv) {
      throw new InvalidModelError(`Unsupported Bedrock model ID: "${modelId}"`);
    }
    return normalized;
  }

  getModelCatalog(): {
    models: AiModelOption[];
    defaultScoutModelId: string;
    defaultCopywriterModelId: string;
  } {
    return {
      models: BEDROCK_MODEL_CATALOG,
      defaultScoutModelId: this.defaultScoutModelId,
      defaultCopywriterModelId: this.defaultCopywriterModelId,
    };
  }

  async isAvailable(): Promise<boolean> {
    if (this.hasCustomClient) {
      return true;
    }
    if (this.options.available !== undefined) {
      return this.options.available;
    }
    const hasEnvCredsOrRegion = Boolean(
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.AWS_EXECUTION_ENV ||
      process.env.AWS_REGION ||
      process.env.AWS_DEFAULT_REGION ||
      process.env.AWS_PROFILE ||
      process.env.AWS_ACCESS_KEY_ID ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      process.env.BEDROCK_SCOUT_MODEL_ID ||
      process.env.BEDROCK_COPYWRITER_MODEL_ID
    );
    if (hasEnvCredsOrRegion) {
      return true;
    }
    try {
      const home = os.homedir();
      const configPath = path.join(home, '.aws', 'config');
      const credsPath = path.join(home, '.aws', 'credentials');
      return fs.existsSync(configPath) || fs.existsSync(credsPath);
    } catch {
      return false;
    }
  }

  decorateScoutPrompt(domainPrompt: string): string {
    return domainPrompt;
  }

  sanitizeResponse(rawText: string): string {
    return sanitizeBedrockResponse(rawText);
  }

  async generate(prompt: string, apiKeyOrOptions?: string | GenerateOptions): Promise<string> {
    let modelId = this.defaultCopywriterModelId;
    let abortSignal: AbortSignal | undefined = undefined;

    if (typeof apiKeyOrOptions === 'object' && apiKeyOrOptions !== null) {
      if (apiKeyOrOptions.modelId) {
        modelId = this.validateModelId(apiKeyOrOptions.modelId);
      }
      abortSignal = apiKeyOrOptions.abortSignal;
    }

    const command = new ConverseCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 4096, temperature: 0.4 },
    });

    const response = await this.client.send(command, abortSignal ? { abortSignal } : undefined);
    const contentBlocks = response.output?.message?.content ?? [];
    const textPieces: string[] = [];

    for (const block of contentBlocks) {
      if (typeof block.text === 'string') {
        textPieces.push(block.text);
      }
    }

    const rawText = textPieces.join('');
    const cleaned = sanitizeBedrockResponse(rawText);
    if (!cleaned) {
      throw new Error('No text content returned from Bedrock Converse');
    }
    return cleaned;
  }

  async generateStreamWithTools(
    prompt: string,
    tools: ToolDeclaration[],
    dispatcher: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    onChunk: (event: ScoutStreamEvent) => void,
    options?: GenerateOptions
  ): Promise<GenerateStreamWithToolsResult> {
    const activeModelId = options?.modelId
      ? this.validateModelId(options.modelId)
      : this.defaultScoutModelId;

    const messages: Message[] = [{ role: 'user', content: [{ text: prompt }] }];
    const toolConfig: ToolConfiguration | undefined =
      tools.length > 0
        ? ({
            tools: tools.map((t) => ({
              toolSpec: {
                name: t.name,
                description: t.description,
                inputSchema: {
                  json: t.inputSchema as unknown as DocumentType,
                },
              },
            })),
          } as unknown as ToolConfiguration)
        : undefined;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let accumulatedFinalText = '';

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      if (options?.abortSignal?.aborted) {
        throw new Error('Request aborted');
      }

      const command = new ConverseStreamCommand({
        modelId: activeModelId,
        messages,
        ...(toolConfig ? { toolConfig } : {}),
        inferenceConfig: { maxTokens: 8192, temperature: 0.4 },
      });

      const response = await this.client.send(
        command,
        options?.abortSignal ? { abortSignal: options.abortSignal } : undefined
      );

      let turnRawText = '';
      let emittedVisibleLen = 0;
      let emittedReasoningThought = false;
      let stopReason: string | undefined = undefined;
      const toolUseMap = new Map<number, { toolUseId: string; name: string; inputJson: string }>();

      if (!response.stream) {
        throw new Error('No stream returned from Bedrock ConverseStream');
      }

      for await (const chunk of response.stream) {
        if (options?.abortSignal?.aborted) {
          throw new Error('Request aborted');
        }

        if (chunk.contentBlockStart?.start?.toolUse) {
          const idx = chunk.contentBlockStart.contentBlockIndex ?? 0;
          const tu = chunk.contentBlockStart.start.toolUse;
          toolUseMap.set(idx, {
            toolUseId: tu.toolUseId ?? `tool_${Date.now()}_${idx}`,
            name: tu.name ?? '',
            inputJson: '',
          });
        }

        if (chunk.contentBlockDelta?.delta?.reasoningContent?.text) {
          if (!emittedReasoningThought) {
            emittedReasoningThought = true;
            onChunk({ event: 'thought', data: { text: 'Reasoning through route options...' } });
          }
        }

        if (chunk.contentBlockDelta?.delta?.text) {
          turnRawText += chunk.contentBlockDelta.delta.text;
          const visibleSoFar = turnRawText
            .replace(/<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>/gi, '')
            .replace(/<(?:thinking|think)>[\s\S]*$/i, '')
            .replace(/<\/?(?:t(?:h(?:i(?:n(?:k(?:i(?:n(?:g)?)?)?)?)?)?)?)?$/i, '');
          if (visibleSoFar.length > emittedVisibleLen) {
            const newDelta = visibleSoFar.slice(emittedVisibleLen);
            emittedVisibleLen = visibleSoFar.length;
            onChunk({ event: 'delta', data: { text: newDelta } });
          }
        }

        if (chunk.contentBlockDelta?.delta?.toolUse?.input) {
          const idx = chunk.contentBlockDelta.contentBlockIndex ?? 0;
          const existing = toolUseMap.get(idx);
          if (existing) {
            existing.inputJson += chunk.contentBlockDelta.delta.toolUse.input;
          }
        }

        if (chunk.messageStop?.stopReason) {
          stopReason = chunk.messageStop.stopReason;
        }

        if (chunk.metadata?.usage) {
          if (typeof chunk.metadata.usage.inputTokens === 'number') {
            totalInputTokens += chunk.metadata.usage.inputTokens;
          }
          if (typeof chunk.metadata.usage.outputTokens === 'number') {
            totalOutputTokens += chunk.metadata.usage.outputTokens;
          }
        }
      }

      const fullVisibleTurnText = turnRawText
        .replace(/<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>/gi, '')
        .replace(/<(?:thinking|think)>[\s\S]*$/i, '');
      if (fullVisibleTurnText.length > emittedVisibleLen) {
        const trailingDelta = fullVisibleTurnText.slice(emittedVisibleLen);
        emittedVisibleLen = fullVisibleTurnText.length;
        onChunk({ event: 'delta', data: { text: trailingDelta } });
      }

      const cleanedTurnText = sanitizeBedrockResponse(turnRawText);
      const pendingTools = Array.from(toolUseMap.values());

      if (stopReason === 'tool_use' && pendingTools.length > 0) {
        if (iteration === MAX_TOOL_ITERATIONS - 1) {
          throw new Error(`Route Scout exceeded maximum tool iterations (${MAX_TOOL_ITERATIONS})`);
        }

        const assistantContent: ContentBlock[] = [];
        if (cleanedTurnText) {
          assistantContent.push({ text: cleanedTurnText });
          accumulatedFinalText += (accumulatedFinalText ? '\n\n' : '') + cleanedTurnText;
        }
        for (const t of pendingTools) {
          let parsedInput: Record<string, unknown> = {};
          try {
            if (t.inputJson.trim()) {
              parsedInput = JSON.parse(t.inputJson) as Record<string, unknown>;
            }
          } catch {
            parsedInput = {};
          }
          assistantContent.push({
            toolUse: {
              toolUseId: t.toolUseId,
              name: t.name,
              input: parsedInput as unknown as DocumentType,
            },
          } as unknown as ContentBlock);
        }
        messages.push({ role: 'assistant', content: assistantContent });

        const toolResultBlocks: ContentBlock[] = (await Promise.all(
          pendingTools.map(async (t) => {
            let parsedInput: Record<string, unknown> = {};
            try {
              if (t.inputJson.trim()) {
                parsedInput = JSON.parse(t.inputJson) as Record<string, unknown>;
              }
            } catch {
              parsedInput = {};
            }
            onChunk({
              event: 'activity',
              data: {
                id: t.toolUseId,
                type: t.name === 'search_web' ? 'search' : 'tool',
                label: formatBedrockToolLabel(t.name, parsedInput, false),
                state: 'active',
              },
            });
            const t0 = Date.now();
            let resultValue: unknown = undefined;
            let isErr = false;
            try {
              resultValue = await dispatcher(t.name, parsedInput);
            } catch (dispatchErr: unknown) {
              isErr = true;
              resultValue = {
                error: dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr),
              };
            }
            const durationSeconds = Number(((Date.now() - t0) / 1000).toFixed(1));
            onChunk({
              event: 'activity',
              data: {
                id: t.toolUseId,
                type: t.name === 'search_web' ? 'search' : 'tool',
                label: formatBedrockToolLabel(t.name, parsedInput, true),
                state: isErr ? 'error' : 'done',
                durationSeconds,
              },
            });
            const jsonPayload: Record<string, unknown> =
              typeof resultValue === 'object' && resultValue !== null && !Array.isArray(resultValue)
                ? (resultValue as Record<string, unknown>)
                : { result: resultValue };
            return {
              toolResult: {
                toolUseId: t.toolUseId,
                content: [{ json: jsonPayload as unknown as DocumentType }],
                status: (isErr ? 'error' : 'success') as ToolResultStatus,
              },
            };
          })
        )) as unknown as ContentBlock[];

        messages.push({ role: 'user', content: toolResultBlocks });
        // Continue next iteration of tool loop
      } else {
        if (cleanedTurnText) {
          accumulatedFinalText += (accumulatedFinalText ? '\n\n' : '') + cleanedTurnText;
        }
        return {
          text: sanitizeBedrockResponse(accumulatedFinalText),
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        };
      }
    }

    return {
      text: sanitizeBedrockResponse(accumulatedFinalText),
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    };
  }
}
