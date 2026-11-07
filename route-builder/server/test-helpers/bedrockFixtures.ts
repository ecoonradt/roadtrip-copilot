import type { PricingClient } from '@aws-sdk/client-pricing';
import {
  PRICED_REGION,
  type BedrockModelTokenRate,
  type BedrockPricingCatalog,
} from '../services/bedrockPricing.js';
import {
  DEFAULT_BEDROCK_COPYWRITER_MODEL_ID,
  DEFAULT_BEDROCK_SCOUT_MODEL_ID,
} from '../services/bedrockService.js';
import type {
  WaypointContext,
  ToolDeclaration,
  AiModelOption,
} from '../types/ai.js';
import type { ScoutTripContext } from '../types/scout.js';

export const TEST_PRICING_REFRESHED_AT = '2026-11-02T00:00:00.000Z';
export const TEST_PRICING_REFRESHED_MS = Date.parse(TEST_PRICING_REFRESHED_AT);

export const TEST_KIMI_RATE: BedrockModelTokenRate = {
  modelId: DEFAULT_BEDROCK_SCOUT_MODEL_ID,
  foundationModelId: 'moonshotai.kimi-k3',
  providerName: 'Moonshot AI',
  inputPerMillionUsd: '3.300000000',
  outputPerMillionUsd: '16.500000000',
  cacheReadPerMillionUsd: '0.330000000',
  cacheWritePerMillionUsd: '4.125000000',
};

export const TEST_NOVA_RATE: BedrockModelTokenRate = {
  modelId: DEFAULT_BEDROCK_COPYWRITER_MODEL_ID,
  foundationModelId: 'amazon.nova-2-lite-v1:0',
  providerName: 'Amazon',
  inputPerMillionUsd: '0.330000000',
  outputPerMillionUsd: '2.750000000',
  cacheReadPerMillionUsd: '0.082500000',
  cacheWritePerMillionUsd: '0.000000000',
};

export function makeTestPricingCatalog(
  overrides?: Partial<BedrockPricingCatalog>,
): BedrockPricingCatalog {
  return {
    schemaVersion: 1,
    region: PRICED_REGION,
    refreshedAt: TEST_PRICING_REFRESHED_AT,
    models: {
      [DEFAULT_BEDROCK_SCOUT_MODEL_ID]: TEST_KIMI_RATE,
      [DEFAULT_BEDROCK_COPYWRITER_MODEL_ID]: TEST_NOVA_RATE,
    },
    unpricedModelIds: [],
    ...overrides,
  };
}

export function makeTestPriceEntry(params: {
  serviceCode: string;
  usagetype: string;
  model: string;
  inferenceType: string;
  unit: string;
  usd: string;
  provider: string;
}): string {
  const sku = `${params.usagetype}-${params.usd}`.replace(/\s+/g, '_');
  return JSON.stringify({
    product: {
      productFamily: 'Amazon Bedrock',
      attributes: {
        regionCode: PRICED_REGION,
        inferenceType: params.inferenceType,
        servicecode: params.serviceCode,
        provider: params.provider,
        usagetype: params.usagetype,
        locationType: 'AWS Region',
        location: 'US East (Ohio)',
        model: params.model,
        servicename: 'Amazon Bedrock',
        feature: 'On-demand Inference',
      },
      sku,
    },
    serviceCode: params.serviceCode,
    terms: {
      OnDemand: {
        [`${sku}.TERM`]: {
          priceDimensions: {
            [`${sku}.TERM.DIM`]: {
              unit: params.unit,
              endRange: 'Inf',
              description: `${params.usagetype} ${params.unit}`,
              beginRange: '0',
              pricePerUnit: { USD: params.usd },
            },
          },
        },
      },
    },
  });
}

export function makeDefaultPricingClientMock(): PricingClient {
  const amazonBedrockEntries = [
    makeTestPriceEntry({
      serviceCode: 'AmazonBedrock',
      usagetype: 'USE2-moonshotai.kimi-k3-mantle-input-tokens-standard',
      model: 'Kimi K3',
      inferenceType: 'Input tokens',
      unit: '1K tokens',
      usd: '0.0033000000',
      provider: 'Moonshot AI',
    }),
    makeTestPriceEntry({
      serviceCode: 'AmazonBedrock',
      usagetype: 'USE2-moonshotai.kimi-k3-mantle-output-tokens-standard',
      model: 'Kimi K3',
      inferenceType: 'Output tokens',
      unit: '1K tokens',
      usd: '0.0165000000',
      provider: 'Moonshot AI',
    }),
    makeTestPriceEntry({
      serviceCode: 'AmazonBedrock',
      usagetype: 'USE2-moonshotai.kimi-k3-mantle-cache-read-tokens-standard',
      model: 'Kimi K3',
      inferenceType: 'Cache read tokens',
      unit: '1K tokens',
      usd: '0.0003300000',
      provider: 'Moonshot AI',
    }),
    makeTestPriceEntry({
      serviceCode: 'AmazonBedrock',
      usagetype: 'USE2-moonshotai.kimi-k3-mantle-cache-write-tokens-30m-standard',
      model: 'Kimi K3',
      inferenceType: 'Cache write tokens',
      unit: '1K tokens',
      usd: '0.0041250000',
      provider: 'Moonshot AI',
    }),
    makeTestPriceEntry({
      serviceCode: 'AmazonBedrock',
      usagetype: 'USE2-Nova2.0Lite-input-tokens',
      model: 'Nova 2 Lite',
      inferenceType: 'Input tokens',
      unit: '1K tokens',
      usd: '0.0003300000',
      provider: 'Amazon',
    }),
    makeTestPriceEntry({
      serviceCode: 'AmazonBedrock',
      usagetype: 'USE2-Nova2.0Lite-output-tokens',
      model: 'Nova 2 Lite',
      inferenceType: 'Output tokens',
      unit: '1K tokens',
      usd: '0.0027500000',
      provider: 'Amazon',
    }),
    makeTestPriceEntry({
      serviceCode: 'AmazonBedrock',
      usagetype: 'USE2-Nova2.0Lite-cache-read-input-token-count',
      model: 'Nova 2 Lite',
      inferenceType: 'Cache read tokens',
      unit: '1K tokens',
      usd: '0.0000825000',
      provider: 'Amazon',
    }),
    makeTestPriceEntry({
      serviceCode: 'AmazonBedrock',
      usagetype: 'USE2-Nova2.0Lite-cache-write-input-token-count',
      model: 'Nova 2 Lite',
      inferenceType: 'Cache write tokens',
      unit: '1K tokens',
      usd: '0.0000000000',
      provider: 'Amazon',
    }),
  ];

  const marketplaceEntries = [
    makeTestPriceEntry({
      serviceCode: 'AmazonBedrockFoundationModels',
      usagetype: 'USE2-MP:USE2_InputTokenCount-Units',
      model: 'Claude Sonnet 4.6',
      inferenceType: 'Input tokens',
      unit: '1M tokens',
      usd: '3.3000000000',
      provider: 'Anthropic',
    }),
    makeTestPriceEntry({
      serviceCode: 'AmazonBedrockFoundationModels',
      usagetype: 'USE2-MP:USE2_OutputTokenCount-Units',
      model: 'Claude Sonnet 4.6',
      inferenceType: 'Output tokens',
      unit: '1M tokens',
      usd: '16.5000000000',
      provider: 'Anthropic',
    }),
  ];

  const send = async (command: { input?: { ServiceCode?: string } }) => {
    const sc = command.input?.ServiceCode;
    if (sc === 'AmazonBedrock') {
      return { PriceList: amazonBedrockEntries };
    }
    if (sc === 'AmazonBedrockFoundationModels') {
      return { PriceList: marketplaceEntries };
    }
    return { PriceList: [] };
  };

  return { send } as unknown as PricingClient;
}

// Helper to create async generator stream for ConverseStreamCommand mocks
export async function* createAsyncStream<T>(chunks: T[]): AsyncIterable<T> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

// Sample test fixtures
export const sampleWaypoint: WaypointContext = {
  id: 'wp_sedona_bell_rock',
  name: 'Sedona Red Rock Vistas (Bell Rock)',
  type: 'scenic_pull_off',
  targetTime: '16:30:00',
  formattedTime: '4:30 PM',
  approachHighway: 'AZ-179 North',
  notes: 'Bell Rock scenic pull-off for photo views',
};

export const sampleTripContext: ScoutTripContext = {
  tripName: 'Phoenix to Sedona Scenic Run',
  date: '2026-10-10',
  origin: 'Phoenix, AZ',
  destination: 'Sedona, AZ',
  departureTime: '08:00:00',
  corridor: 'I-17 N to AZ-179 N Red Rock Scenic Byway',
  waypoints: [
    {
      id: 'wp_origin',
      name: 'Phoenix Origin',
      type: 'origin',
      lat: 33.4484,
      lng: -112.074,
      target_time: '08:00:00',
      dwell_minutes: 0,
    },
    {
      id: 'wp_sedona_bell_rock',
      name: 'Bell Rock Scenic Vista',
      type: 'scenic_pull_off',
      lat: 34.8005,
      lng: -111.7667,
      target_time: '10:00:00',
      dwell_minutes: 20,
    },
    {
      id: 'wp_dest',
      name: 'Sedona Lodging',
      type: 'lodging',
      lat: 34.8697,
      lng: -111.761,
      target_time: '12:00:00',
      dwell_minutes: 0,
    },
  ],
};

export const sampleTools: ToolDeclaration[] = [
  {
    name: 'search_web',
    description: 'Searches the web for corridor queries',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'read_url_content',
    description: 'Reads web content from a URL',
    inputSchema: {
      type: 'object',
      properties: { Url: { type: 'string' } },
      required: ['Url'],
    },
  },
];

export const TEST_MOCK_MODELS: AiModelOption[] = [
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
