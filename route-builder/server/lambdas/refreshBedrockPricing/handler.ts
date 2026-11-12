import * as path from 'node:path';
import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
  type FoundationModelSummary,
  type InferenceProfileSummary,
} from '@aws-sdk/client-bedrock';
import type { PricingClient } from '@aws-sdk/client-pricing';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  fetchBedrockPricingCatalog,
  PricingUnavailableError,
  PRICED_REGION,
  type BedrockPricingCatalog,
  type DiscoveredBedrockModel,
} from '../../services/ai/bedrock/bedrockPricing.js';
import { BedrockPricingCache } from '../../services/ai/bedrock/bedrockPricingCache.js';

const DEFAULT_SCOUT_MODEL_ID = 'us.moonshotai.kimi-k3';
const DEFAULT_COPYWRITER_MODEL_ID = 'us.amazon.nova-2-lite-v1:0';

const CROSS_REGION_PROFILE_PREFIXES = ['global.', 'us-gov.', 'us.', 'eu.', 'apac.'];

function stripProfilePrefix(modelId: string): string {
  const prefix = CROSS_REGION_PROFILE_PREFIXES.find((candidate) =>
    modelId.startsWith(candidate),
  );
  return prefix ? modelId.slice(prefix.length) : modelId;
}

function inferProviderName(modelId: string): string {
  const foundationId = stripProfilePrefix(modelId);
  const prefix = foundationId.split('.')[0]?.toLowerCase() ?? '';
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

function isEligibleTextFoundationModel(fm?: FoundationModelSummary): fm is FoundationModelSummary {
  if (!fm) return false;
  if (fm.modelLifecycle?.status === 'LEGACY') return false;
  const hasTextIn = fm.inputModalities?.includes('TEXT') === true;
  const hasTextOut = fm.outputModalities?.includes('TEXT') === true;
  return hasTextIn && hasTextOut;
}

async function listActiveSystemProfiles(
  bedrockClient: BedrockClient,
): Promise<Map<string, { profile: InferenceProfileSummary; foundationId: string }>> {
  const activeProfiles = new Map<
    string,
    { profile: InferenceProfileSummary; foundationId: string }
  >();
  let nextToken: string | undefined;

  do {
    const res = await bedrockClient.send(
      new ListInferenceProfilesCommand({ maxResults: 1000, nextToken }),
    );
    for (const profile of res.inferenceProfileSummaries ?? []) {
      if (profile.status !== 'ACTIVE' || !profile.inferenceProfileId) {
        continue;
      }
      const isSystemDefined =
        profile.type === 'SYSTEM_DEFINED' ||
        CROSS_REGION_PROFILE_PREFIXES.some((pfx) =>
          profile.inferenceProfileId!.startsWith(pfx),
        );
      if (!isSystemDefined) {
        continue;
      }

      let foundationId: string | undefined;
      const firstModelArn = profile.models?.[0]?.modelArn;
      if (firstModelArn && firstModelArn.includes('foundation-model/')) {
        foundationId = firstModelArn.split('foundation-model/')[1]?.trim();
      }
      if (!foundationId) {
        foundationId = stripProfilePrefix(profile.inferenceProfileId);
      }

      activeProfiles.set(profile.inferenceProfileId, { profile, foundationId });
    }
    nextToken = res.nextToken;
  } while (nextToken);

  return activeProfiles;
}

async function listTextFoundationModels(
  bedrockClient: BedrockClient,
): Promise<Map<string, FoundationModelSummary>> {
  const foundationModels = new Map<string, FoundationModelSummary>();
  const res = await bedrockClient.send(
    new ListFoundationModelsCommand({ byOutputModality: 'TEXT' }),
  );
  for (const model of res.modelSummaries ?? []) {
    if (!model.modelId) continue;
    foundationModels.set(model.modelId, model);
  }
  return foundationModels;
}

export async function discoverBedrockModelsForPricing(options?: {
  bedrockClient?: BedrockClient;
  region?: string;
}): Promise<DiscoveredBedrockModel[]> {
  const region =
    options?.region ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    PRICED_REGION;
  const bedrockClient =
    options?.bedrockClient ?? new BedrockClient({ region });

  const [activeProfiles, foundationModels] = await Promise.all([
    listActiveSystemProfiles(bedrockClient),
    listTextFoundationModels(bedrockClient),
  ]);

  const discovered: DiscoveredBedrockModel[] = [];
  const seenModelIds = new Set<string>();
  const foundationsWithProfiles = new Set<string>();

  for (const [profileId, { profile, foundationId }] of activeProfiles) {
    const fm = foundationModels.get(foundationId);
    if (!isEligibleTextFoundationModel(fm)) {
      continue;
    }
    foundationsWithProfiles.add(foundationId);
    if (seenModelIds.has(profileId)) {
      continue;
    }
    seenModelIds.add(profileId);
    discovered.push({
      modelId: profileId,
      foundationModelId: foundationId,
      providerName: fm.providerName || inferProviderName(profileId),
      modelName: fm.modelName || profile.inferenceProfileName || profileId,
    });
  }

  for (const [fmId, fm] of foundationModels) {
    if (!isEligibleTextFoundationModel(fm)) {
      continue;
    }
    if (foundationsWithProfiles.has(fmId)) {
      continue;
    }
    if (
      fm.inferenceTypesSupported &&
      !fm.inferenceTypesSupported.includes('ON_DEMAND')
    ) {
      continue;
    }
    if (seenModelIds.has(fmId)) {
      continue;
    }
    seenModelIds.add(fmId);
    discovered.push({
      modelId: fmId,
      foundationModelId: fmId,
      providerName: fm.providerName || inferProviderName(fmId),
      modelName: fm.modelName || fmId,
    });
  }

  return discovered;
}

export interface RefreshBedrockPricingOptions {
  bedrockClient?: BedrockClient;
  pricingClient?: PricingClient;
  pricingCache?: BedrockPricingCache;
  discoveredModels?: DiscoveredBedrockModel[];
  s3Bucket?: string;
  s3Client?: S3Client;
  localFilePath?: string;
  region?: string;
  now?: () => number;
}

export interface RefreshBedrockPricingResult {
  catalog: BedrockPricingCatalog;
  storageLocation: string;
  pricedModelCount: number;
  unpricedModelCount: number;
}

export async function refreshBedrockPricing(
  options: RefreshBedrockPricingOptions = {},
): Promise<RefreshBedrockPricingResult> {
  const discoveredModels =
    options.discoveredModels ??
    (await discoverBedrockModelsForPricing({
      bedrockClient: options.bedrockClient,
      region: options.region,
    }));

  const catalog = await fetchBedrockPricingCatalog({
    discoveredModels,
    pricingClient: options.pricingClient,
    now: options.now,
  });

  const requiredDefaults = [
    (process.env.BEDROCK_SCOUT_MODEL_ID || DEFAULT_SCOUT_MODEL_ID).trim(),
    (process.env.BEDROCK_COPYWRITER_MODEL_ID || DEFAULT_COPYWRITER_MODEL_ID).trim(),
  ].filter(Boolean);

  for (const defaultModelId of requiredDefaults) {
    const hasDefaultPrice =
      Object.prototype.hasOwnProperty.call(catalog.models, defaultModelId) ||
      Object.values(catalog.models).some(
        (rate) => rate.foundationModelId === defaultModelId,
      );
    if (!hasDefaultPrice) {
      throw new PricingUnavailableError(
        `Refusing to overwrite pricing catalog: configured default model "${defaultModelId}" did not resolve a price`,
      );
    }
  }

  const cache =
    options.pricingCache ??
    new BedrockPricingCache({
      s3Bucket: options.s3Bucket,
      s3Client: options.s3Client,
      localFilePath: options.localFilePath,
      region: options.region,
      now: options.now,
    });

  const { storageLocation } = await cache.writeCatalog(catalog);

  return {
    catalog,
    storageLocation,
    pricedModelCount: Object.keys(catalog.models).length,
    unpricedModelCount: catalog.unpricedModelIds.length,
  };
}

export async function handler(
  _event?: unknown,
): Promise<RefreshBedrockPricingResult> {
  return refreshBedrockPricing();
}

export function loadLocalEnvFileIfPresent(cwd = process.cwd()): void {
  if (typeof process.loadEnvFile !== 'function') return;
  const candidates =
    path.basename(cwd) === 'route-builder'
      ? [path.resolve(cwd, '.env')]
      : [path.resolve(cwd, 'route-builder/.env'), path.resolve(cwd, '.env')];
  for (const envPath of candidates) {
    try {
      process.loadEnvFile(envPath);
      break;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        console.warn(`[refresh:pricing] Notice loading .env file (${envPath}):`, err);
      }
    }
  }
}

const isDirectExecution = (() => {
  const entryArg = process.argv[1];
  if (!entryArg || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return false;
  }
  return /(?:^|[\\/])refreshBedrockPricing[\\/]handler\.[cm]?[jt]s$/.test(
    path.resolve(entryArg),
  );
})();

if (isDirectExecution) {
  loadLocalEnvFileIfPresent();
  refreshBedrockPricing()
    .then((result) => {
      console.log(
        `Refreshed Bedrock pricing catalog (${result.pricedModelCount} priced, ${result.unpricedModelCount} unpriced) -> ${result.storageLocation}`,
      );
    })
    .catch((err: unknown) => {
      console.error(
        `Failed to refresh Bedrock pricing catalog: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    });
}
