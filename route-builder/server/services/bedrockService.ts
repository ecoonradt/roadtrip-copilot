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
import {
  BedrockClient,
  GetFoundationModelAvailabilityCommand,
  ListInferenceProfilesCommand,
  ListFoundationModelsCommand,
  type FoundationModelSummary,
  type InferenceProfileSummary,
} from '@aws-sdk/client-bedrock';
import type { DocumentType } from '@smithy/types';
import type {
  AiModelOption,
  ToolDeclaration,
  GenerateOptions,
  GenerateStreamWithToolsResult,
} from '../types/ai.js';
import type { ScoutStreamEvent } from '../types/scout.js';
import type { AiHarnessAdapter } from './aiService.js';
import { InvalidModelError } from './aiService.js';
import { MalformedAiResponseError } from './schemaParser.js';

export { InvalidModelError };

export const DEFAULT_BEDROCK_SCOUT_MODEL_ID = 'us.moonshotai.kimi-k3';
export const DEFAULT_BEDROCK_COPYWRITER_MODEL_ID = 'us.amazon.nova-2-lite-v1:0';
export const MAX_TOOL_ITERATIONS = 5;
export const MODEL_AVAILABILITY_TTL_MS = 5 * 60 * 1000;

/**
 * Cross-region inference profile prefixes. `GetFoundationModelAvailability` only accepts a
 * foundation model ID, so the prefix must be removed before querying account availability.
 */
const CROSS_REGION_PROFILE_PREFIXES = ['global.', 'us-gov.', 'us.', 'eu.', 'apac.'];

/**
 * Maps a system-defined inference profile ID (e.g. `us.moonshotai.kimi-k3`) to the underlying
 * foundation model ID (`moonshotai.kimi-k3`). Plain foundation model IDs are returned unchanged.
 */
export function toFoundationModelId(modelId: string): string {
  if (typeof modelId !== 'string') return '';
  const prefix = CROSS_REGION_PROFILE_PREFIXES.find((candidate) => modelId.startsWith(candidate));
  return prefix ? modelId.slice(prefix.length) : modelId;
}

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
  {
    id: 'amazon.nova-lite-v1:0',
    name: 'Amazon Nova Lite',
    provider: 'Amazon',
    description: 'Cost-effective multimodal model for high-volume turns',
    role: 'both',
  },
  {
    id: 'us.openai.gpt-6.1-sol',
    name: 'OpenAI GPT-6.1 Sol',
    provider: 'OpenAI',
    description: 'Advanced frontier co-pilot & corridor logistics (requires AWS account opt-in)',
    role: 'both',
  },
  {
    id: 'us.anthropic.claude-sonnet-4-6',
    name: 'Anthropic Claude Sonnet 4.6',
    provider: 'Anthropic',
    description: 'High-precision corridor analysis & reasoning (requires Anthropic account opt-in)',
    role: 'both',
  },
  {
    id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    name: 'Anthropic Claude Haiku 4.5',
    provider: 'Anthropic',
    description: 'High-speed, lightweight alert copywriting (requires Anthropic account opt-in)',
    role: 'copywriter',
  },
];

export const INFERENCE_PROFILE_ALIASES: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null), {
    'moonshotai.kimi-k3': 'us.moonshotai.kimi-k3',
    'amazon.nova-2-lite-v1:0': 'us.amazon.nova-2-lite-v1:0',
    'amazon.nova-pro-v1:0': 'us.amazon.nova-pro-v1:0',
    'us.amazon.nova-lite-v1:0': 'amazon.nova-lite-v1:0',
    'openai.gpt-6-luna': 'us.openai.gpt-6-luna',
    'openai.gpt-6-sol': 'us.openai.gpt-6-sol',
    'openai.gpt-6.1-sol': 'us.openai.gpt-6.1-sol',
    'openai.gpt-6-astra': 'us.openai.gpt-6-astra',
    'anthropic.claude-sonnet-5-5': 'us.anthropic.claude-sonnet-5-5',
    'anthropic.claude-opus-5-5': 'us.anthropic.claude-opus-5-5',
    'anthropic.claude-sonnet-4-6': 'us.anthropic.claude-sonnet-4-6',
    'anthropic.claude-haiku-4-5-20251001-v1:0': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    'xai.grok-4.7': 'us.xai.grok-4.7',
  })
);

export function getStaticInferenceProfileAlias(modelId: string): string | undefined {
  if (typeof modelId !== 'string') return undefined;
  if (Object.prototype.hasOwnProperty.call(INFERENCE_PROFILE_ALIASES, modelId)) {
    const val = INFERENCE_PROFILE_ALIASES[modelId];
    return typeof val === 'string' ? val : undefined;
  }
  return undefined;
}

export function getProfilePreferenceScore(profileId: string): number {
  if (profileId.startsWith('us.')) return 100;
  if (profileId.startsWith('global.')) return 80;
  if (profileId.startsWith('eu.')) return 60;
  if (profileId.startsWith('apac.')) return 40;
  return 10;
}

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

export interface BedrockAdapterOptions {
  client?: BedrockRuntimeClient;
  controlClient?: BedrockClient;
  region?: string;
  scoutModelId?: string;
  defaultScoutModelId?: string;
  copywriterModelId?: string;
  defaultCopywriterModelId?: string;
  available?: boolean;
  availableModels?: AiModelOption[];
  excludedModelIds?: string[] | Set<string>;
}

export function inferProviderFromModelId(modelId: string): string {
  const foundationId = toFoundationModelId(modelId);
  const prefix = foundationId.split('.')[0]?.toLowerCase() || '';
  switch (prefix) {
    case 'amazon':
      return 'Amazon';
    case 'anthropic':
      return 'Anthropic';
    case 'meta':
      return 'Meta';
    case 'moonshotai':
      return 'Moonshot AI';
    case 'openai':
      return 'OpenAI';
    case 'deepseek':
      return 'DeepSeek';
    case 'mistral':
      return 'Mistral AI';
    case 'cohere':
      return 'Cohere';
    case 'ai21':
      return 'AI21 Labs';
    default:
      return prefix ? prefix.charAt(0).toUpperCase() + prefix.slice(1) : 'Amazon Bedrock';
  }
}

export function inferModelNameFromId(modelId: string): string {
  const foundationId = toFoundationModelId(modelId);
  const parts = foundationId.split('.');
  const modelPart = parts.slice(1).join('.');
  if (!modelPart) return modelId;
  return modelPart
    .split(/[-_:]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function sanitizeBedrockResponse(rawText: string): string {
  if (!rawText) return '';
  let cleaned = rawText;

  // 1. Strip closed <thinking>...</thinking> or <think>...</think> (case-insensitive)
  cleaned = cleaned.replace(/<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>/gi, '');

  // 2. Strip unclosed trailing <thinking>... or <think>... (case-insensitive)
  cleaned = cleaned.replace(/<(?:thinking|think)>[\s\S]*$/i, '');

  // 3. Strip orphaned closing </thinking> or </think> (case-insensitive)
  cleaned = cleaned.replace(/<\/(?:thinking|think)>/gi, '');

  // 4. Strip leading harness noise
  cleaned = cleaned.replace(
    /^(?:Wait for the (?:background )?task to complete\.?|Waiting for (?:background )?task\.?|Wait for the command to finish\.?|Let me inspect[^.\n]*\.\s*)\s*/gi,
    ''
  );

  // 5. Strip trailing meta-commentary narrating cards or JSON
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
  private readonly rawConfiguredScoutModelId: string;
  private readonly rawConfiguredCopywriterModelId: string;
  private client: BedrockRuntimeClient;
  private controlClient: BedrockClient | null;
  private hasCustomClient: boolean;
  private options: BedrockAdapterOptions;
  private availableModels: AiModelOption[] | null = null;
  private availabilityPromise: Promise<AiModelOption[]> | null = null;
  private availabilityCheckedAt = 0;
  private excludedModelIds: Set<string>;
  private discoveredAliases = new Map<string, string>();

  constructor(options: BedrockAdapterOptions = {}) {
    this.options = options;
    const region = options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    this.client = options.client ?? new BedrockRuntimeClient(region ? { region } : {});
    this.hasCustomClient = Boolean(options.client);

    const envExclusions = (process.env.BEDROCK_EXCLUDED_MODEL_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const optExclusions = options.excludedModelIds
      ? Array.from(options.excludedModelIds)
          .map((id) => (typeof id === 'string' ? id.trim() : ''))
          .filter(Boolean)
      : [];
    this.excludedModelIds = new Set([...envExclusions, ...optExclusions]);

    this.availableModels = options.availableModels ?? null;
    if (options.availableModels) {
      this.availabilityCheckedAt = Date.now();
    }
    if (options.controlClient) {
      this.controlClient = options.controlClient;
    } else if (this.hasCustomClient) {
      this.controlClient = null;
    } else {
      this.controlClient = new BedrockClient(region ? { region } : {});
    }

    const rawScout =
      options.scoutModelId ||
      options.defaultScoutModelId ||
      process.env.BEDROCK_SCOUT_MODEL_ID ||
      DEFAULT_BEDROCK_SCOUT_MODEL_ID;
    const cleanScout = typeof rawScout === 'string' ? rawScout.trim() : '';
    this.rawConfiguredScoutModelId = cleanScout;
    this.defaultScoutModelId = getStaticInferenceProfileAlias(cleanScout) || cleanScout;

    const rawCopywriter =
      options.copywriterModelId ||
      options.defaultCopywriterModelId ||
      process.env.BEDROCK_COPYWRITER_MODEL_ID ||
      DEFAULT_BEDROCK_COPYWRITER_MODEL_ID;
    const cleanCopywriter = typeof rawCopywriter === 'string' ? rawCopywriter.trim() : '';
    this.rawConfiguredCopywriterModelId = cleanCopywriter;
    this.defaultCopywriterModelId = getStaticInferenceProfileAlias(cleanCopywriter) || cleanCopywriter;
  }

  public isModelExcluded(modelId: string, foundationId?: string): boolean {
    if (typeof modelId !== 'string' || !modelId) return false;
    if (this.excludedModelIds.has(modelId)) {
      return true;
    }
    const fId = foundationId || toFoundationModelId(modelId);
    if (fId && this.excludedModelIds.has(fId)) {
      return true;
    }
    return false;
  }

  /**
   * Rebuilds the verified model list from Amazon Bedrock control-plane APIs using AWS-driven discovery.
   *
   * 1. Enumerates active system-defined inference profiles (ListInferenceProfiles).
   * 2. Enumerates text foundation models (ListFoundationModels with byOutputModality: TEXT).
   * 3. Evaluates compatibility consistently across profiles and direct models.
   * 4. Normalizes canonical profile aliases from AWS profile metadata.
   * 5. Applies policy-driven exclusions (excludedModelIds / BEDROCK_EXCLUDED_MODEL_IDS).
   * 6. Verifies account availability via GetFoundationModelAvailability.
   */
  async refreshModelAvailability(): Promise<AiModelOption[]> {
    if (this.availabilityPromise) {
      return this.availabilityPromise;
    }
    if (!this.controlClient) {
      if (this.availableModels !== null) {
        return this.availableModels;
      }
      throw new Error(
        'Bedrock control-plane client is unavailable; cannot verify model availability'
      );
    }

    this.availabilityPromise = (async () => {
      try {
        const [activeProfiles, foundationModels] = await Promise.all([
          this.fetchActiveInferenceProfiles(),
          this.fetchFoundationModels(),
        ]);

        const candidateMap = new Map<string, AiModelOption>();
        const profilesByFoundation = new Map<string, Array<{ profileId: string; role: 'scout' | 'copywriter' | 'both' }>>();

        // 1. Evaluate active system-defined inference profiles (e.g. us.*)
        for (const [profileId, { profile, foundationId }] of activeProfiles) {
          const fm = foundationModels.get(foundationId);
          const compat = this.checkModelCompatibility(fm);
          if (!compat.eligible) {
            continue;
          }

          if (this.isModelExcluded(profileId, foundationId)) {
            continue;
          }

          const catalogEntry = BEDROCK_MODEL_CATALOG.find((m) => m.id === profileId);
          const provider = fm?.providerName || catalogEntry?.provider || inferProviderFromModelId(profileId);
          const name = profile.inferenceProfileName || fm?.modelName || catalogEntry?.name || inferModelNameFromId(profileId);
          const description = profile.description || catalogEntry?.description || `${provider} ${name} inference profile`;
          candidateMap.set(profileId, {
            id: profileId,
            name,
            provider,
            description,
            role: compat.role,
          });

          let group = profilesByFoundation.get(foundationId);
          if (!group) {
            group = [];
            profilesByFoundation.set(foundationId, group);
          }
          group.push({ profileId, role: compat.role });
        }

        // 2. Foundation models with direct on-demand invocation
        for (const [fmId, fm] of foundationModels) {
          const compat = this.checkModelCompatibility(fm);
          if (!compat.eligible) {
            continue;
          }
          if (this.isModelExcluded(fmId, fmId)) {
            continue;
          }
          if (profilesByFoundation.has(fmId)) {
            continue;
          }
          if (fm.inferenceTypesSupported && !fm.inferenceTypesSupported.includes('ON_DEMAND')) {
            continue;
          }
          const catalogEntry = BEDROCK_MODEL_CATALOG.find((m) => m.id === fmId);
          const provider = fm.providerName || catalogEntry?.provider || inferProviderFromModelId(fmId);
          const name = fm.modelName || catalogEntry?.name || inferModelNameFromId(fmId);
          const description = catalogEntry?.description || `${provider} ${name} foundation model`;
          candidateMap.set(fmId, {
            id: fmId,
            name,
            provider,
            description,
            role: compat.role,
          });
        }

        // Compute dynamic aliases deterministically from eligible, non-excluded profiles
        const dynamicAliases = new Map<string, string>();
        for (const [foundationId, profileList] of profilesByFoundation) {
          if (profileList.length === 0) continue;
          profileList.sort((a, b) => {
            const scoreA = getProfilePreferenceScore(a.profileId);
            const scoreB = getProfilePreferenceScore(b.profileId);
            if (scoreA !== scoreB) {
              return scoreB - scoreA;
            }
            return a.profileId.localeCompare(b.profileId);
          });
          dynamicAliases.set(foundationId, profileList[0].profileId);
        }

        this.discoveredAliases = dynamicAliases;

        // 3. Apply policy exclusions defense-in-depth
        for (const candidateId of Array.from(candidateMap.keys())) {
          const activeEntry = activeProfiles.get(candidateId);
          const fId = activeEntry ? activeEntry.foundationId : toFoundationModelId(candidateId);
          if (this.isModelExcluded(candidateId, fId)) {
            candidateMap.delete(candidateId);
          }
        }

        const candidates = Array.from(candidateMap.values());
        const checks: Array<AiModelOption | null> = [];
        const batchSize = 5;
        for (let start = 0; start < candidates.length; start += batchSize) {
          const batch = candidates.slice(start, start + batchSize);
          const batchResults = await Promise.all(
            batch.map(async (model) => {
              const activeProfileEntry = activeProfiles.get(model.id);
              const foundationModelId = activeProfileEntry ? activeProfileEntry.foundationId : toFoundationModelId(model.id);
              const isInferenceProfile = activeProfileEntry !== undefined || foundationModelId !== model.id;

              if (isInferenceProfile && !activeProfiles.has(model.id)) {
                return null;
              }

              // Operational failures (e.g. AccessDeniedException, network, throttling) propagate loudly (R2)
              const res = await this.controlClient!.send(
                new GetFoundationModelAvailabilityCommand({ modelId: foundationModelId })
              );
              const agreementStatus = res.agreementAvailability?.status;
              const hasAgreement = agreementStatus === undefined || agreementStatus === 'AVAILABLE';
              const regionAvailable =
                isInferenceProfile || res.regionAvailability === 'AVAILABLE';
              const isAvailable =
                res.authorizationStatus === 'AUTHORIZED' &&
                res.entitlementAvailability === 'AVAILABLE' &&
                hasAgreement &&
                regionAvailable;
              return isAvailable ? model : null;
            })
          );
          checks.push(...batchResults);
        }

        const verified = checks.filter((m): m is AiModelOption => m !== null);
        this.availableModels = verified;
        this.availabilityCheckedAt = Date.now();
        return this.availableModels;
      } finally {
        this.availabilityPromise = null;
      }
    })();

    return this.availabilityPromise;
  }

  private checkModelCompatibility(fm?: FoundationModelSummary): {
    eligible: boolean;
    role: 'scout' | 'copywriter' | 'both';
    reason?: string;
  } {
    if (!fm) {
      return { eligible: false, role: 'copywriter', reason: 'Missing foundation model metadata' };
    }
    if (fm.modelLifecycle?.status === 'LEGACY') {
      return { eligible: false, role: 'copywriter', reason: 'Legacy foundation model status' };
    }
    const hasTextIn = fm.inputModalities?.includes('TEXT');
    const hasTextOut = fm.outputModalities?.includes('TEXT');
    if (!hasTextIn || !hasTextOut) {
      return { eligible: false, role: 'copywriter', reason: 'Non-text foundation model modalities' };
    }
    // Only assign streaming capability if explicitly supported by AWS metadata (R3)
    const role: 'scout' | 'copywriter' | 'both' =
      fm.responseStreamingSupported === true ? 'both' : 'copywriter';
    return { eligible: true, role };
  }

  private async fetchActiveInferenceProfiles(): Promise<
    Map<string, { profile: InferenceProfileSummary; foundationId: string }>
  > {
    const activeProfiles = new Map<string, { profile: InferenceProfileSummary; foundationId: string }>();
    let nextToken: string | undefined;

    do {
      const res = await this.controlClient!.send(
        new ListInferenceProfilesCommand({ maxResults: 1000, nextToken })
      );
      for (const profile of res.inferenceProfileSummaries ?? []) {
        if (profile.status !== 'ACTIVE' || !profile.inferenceProfileId) {
          continue;
        }
        // Exclude unsupported application profiles from M3 per R4 recommendation
        const isSystemDefined =
          profile.type === 'SYSTEM_DEFINED' ||
          CROSS_REGION_PROFILE_PREFIXES.some((pfx) => profile.inferenceProfileId!.startsWith(pfx));
        if (!isSystemDefined) {
          continue;
        }

        let foundationId: string | undefined;
        const firstModelArn = profile.models?.[0]?.modelArn;
        if (firstModelArn && firstModelArn.includes('foundation-model/')) {
          foundationId = firstModelArn.split('foundation-model/')[1]?.trim();
        }
        if (!foundationId) {
          foundationId = toFoundationModelId(profile.inferenceProfileId);
        }

        activeProfiles.set(profile.inferenceProfileId, { profile, foundationId });
      }
      nextToken = res.nextToken;
    } while (nextToken);

    return activeProfiles;
  }

  private async fetchFoundationModels(): Promise<Map<string, FoundationModelSummary>> {
    const foundationModels = new Map<string, FoundationModelSummary>();
    // Propagate ListFoundationModels failures loudly without swallowing (R2)
    const res = await this.controlClient!.send(
      new ListFoundationModelsCommand({ byOutputModality: 'TEXT' })
    );
    for (const model of res.modelSummaries ?? []) {
      if (!model.modelId) continue;
      foundationModels.set(model.modelId, model);
    }
    return foundationModels;
  }

  async getAvailableModels(): Promise<AiModelOption[]> {
    const isFresh =
      this.availableModels !== null &&
      Date.now() - this.availabilityCheckedAt < MODEL_AVAILABILITY_TTL_MS;
    if (isFresh) {
      return this.availableModels as AiModelOption[];
    }
    return this.refreshModelAvailability();
  }

  resolveCanonicalModelId(modelId: string): string {
    if (typeof modelId !== 'string') return '';
    const trimmed = modelId.trim();
    if (!trimmed) return '';
    return this.discoveredAliases.get(trimmed) || getStaticInferenceProfileAlias(trimmed) || trimmed;
  }

  async validateModelId(modelId: string, role?: 'scout' | 'copywriter'): Promise<string> {
    if (typeof modelId !== 'string') {
      throw new InvalidModelError('Model ID must not be empty');
    }
    const trimmed = modelId.trim();
    if (!trimmed) {
      throw new InvalidModelError('Model ID must not be empty');
    }

    if (this.isModelExcluded(trimmed, toFoundationModelId(trimmed))) {
      throw new InvalidModelError(`Bedrock model ID is excluded by policy: "${modelId}"`);
    }

    // Ensure the catalog/alias snapshot is current BEFORE resolving and checking the effective ID (Finding 1)
    const available = await this.getAvailableModels();

    const normalized = this.resolveCanonicalModelId(trimmed);
    const foundationId = toFoundationModelId(normalized);

    // Apply exclusions against the resolved identity, bare ID, and foundation ID (Finding 2)
    if (
      this.isModelExcluded(normalized, foundationId) ||
      this.isModelExcluded(trimmed, toFoundationModelId(trimmed))
    ) {
      throw new InvalidModelError(`Bedrock model ID is excluded by policy: "${modelId}"`);
    }

    const candidate = available.find((m) => m.id === normalized);
    if (!candidate) {
      throw new InvalidModelError(`Unsupported or unavailable Bedrock model ID: "${modelId}"`);
    }

    if (role === 'scout' && candidate.role !== 'scout' && candidate.role !== 'both') {
      throw new InvalidModelError(`Bedrock model "${modelId}" does not support streaming/scout role`);
    }
    if (role === 'copywriter' && candidate.role !== 'copywriter' && candidate.role !== 'both') {
      throw new InvalidModelError(`Bedrock model "${modelId}" does not support copywriter role`);
    }

    return normalized;
  }

  getModelCatalog(): {
    models: AiModelOption[];
    defaultScoutModelId: string;
    defaultCopywriterModelId: string;
  } {
    const rawScout = this.rawConfiguredScoutModelId || this.defaultScoutModelId;
    const rawCopywriter = this.rawConfiguredCopywriterModelId || this.defaultCopywriterModelId;
    const scoutDefault = this.resolveCanonicalModelId(rawScout);
    const copywriterDefault = this.resolveCanonicalModelId(rawCopywriter);
    return {
      models: this.availableModels ?? BEDROCK_MODEL_CATALOG,
      defaultScoutModelId: scoutDefault,
      defaultCopywriterModelId: copywriterDefault,
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

  async generate(prompt: string, options?: GenerateOptions): Promise<string> {
    const abortSignal = options?.abortSignal;
    if (abortSignal?.aborted) {
      throw new Error('Request aborted');
    }

    const rawModelId = options?.modelId || this.rawConfiguredCopywriterModelId || this.defaultCopywriterModelId;
    const modelId = await this.validateModelId(rawModelId, 'copywriter');

    const command = new ConverseCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 4096, temperature: 0.4 },
    });

    const response = await this.client.send(command, abortSignal ? { abortSignal } : undefined);
    if (response.stopReason === 'max_tokens') {
      throw new MalformedAiResponseError('Model response was truncated: maximum token allowance reached (max_tokens)');
    }
    if (response.stopReason === 'content_filtered') {
      throw new MalformedAiResponseError('Model response was filtered by content policy (stopReason: "content_filtered")');
    }
    if (response.stopReason !== undefined && response.stopReason !== 'end_turn' && response.stopReason !== 'stop_sequence') {
      throw new MalformedAiResponseError(`Model stopped unexpectedly with reason: "${response.stopReason}"`);
    }

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
      throw new MalformedAiResponseError('AI provider returned an empty response');
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
    if (options?.abortSignal?.aborted) {
      throw new Error('Request aborted');
    }

    const rawModelId = options?.modelId || this.rawConfiguredScoutModelId || this.defaultScoutModelId;
    const activeModelId = await this.validateModelId(rawModelId, 'scout');

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
        inferenceConfig: { maxTokens: 4096, temperature: 0.4 },
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

      if (stopReason === 'tool_use') {
        if (pendingTools.length === 0) {
          throw new MalformedAiResponseError('Model signaled tool_use but emitted no executable tool calls');
        }
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
      } else if (stopReason === 'end_turn' || stopReason === 'stop_sequence') {
        if (cleanedTurnText) {
          accumulatedFinalText += (accumulatedFinalText ? '\n\n' : '') + cleanedTurnText;
        }
        const finalText = sanitizeBedrockResponse(accumulatedFinalText);
        if (!finalText) {
          throw new MalformedAiResponseError('AI provider returned an empty response');
        }
        return {
          text: finalText,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        };
      } else if (stopReason === 'max_tokens') {
        throw new MalformedAiResponseError('Model response was truncated: maximum token allowance reached (max_tokens)');
      } else if (stopReason === 'content_filtered') {
        throw new MalformedAiResponseError('Model response was filtered by content policy (stopReason: "content_filtered")');
      } else if (!stopReason) {
        throw new MalformedAiResponseError('Model stream ended unexpectedly without a terminal message');
      } else {
        throw new MalformedAiResponseError(`Model stopped unexpectedly with reason: "${stopReason}"`);
      }
    }

    throw new Error(`Route Scout exceeded maximum tool iterations (${MAX_TOOL_ITERATIONS})`);
  }
}
