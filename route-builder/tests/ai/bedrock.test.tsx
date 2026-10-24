import React from 'react';
import * as renderer from 'react-test-renderer';
import type { ReactTestRenderer, ReactTestInstance } from 'react-test-renderer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AwsBedrockHarnessAdapter,
  InvalidModelError,
  BEDROCK_MODEL_CATALOG,
  DEFAULT_BEDROCK_SCOUT_MODEL_ID,
  DEFAULT_BEDROCK_COPYWRITER_MODEL_ID,
  MAX_TOOL_ITERATIONS,
  MODEL_AVAILABILITY_TTL_MS,
  sanitizeBedrockResponse,
  formatBedrockToolLabel,
  toFoundationModelId,
} from '../../server/services/bedrockService.js';
import type { BedrockClient } from '@aws-sdk/client-bedrock';
import {
  AiService,
  type AiHarnessAdapter,
} from '../../server/services/aiService.js';
import { ScoutService } from '../../server/services/scoutService.js';
import { createApp } from '../../server/app.js';
import { chatWithScoutStream } from '../../src/services/api.js';
import { RouteScoutDrawer } from '../../src/components/RouteScoutDrawer.js';
import { EditWaypointModal } from '../../src/components/EditWaypointModal.js';
import type {
  WaypointContext,
  ToolDeclaration,
} from '../../server/types/ai.js';
import type {
  ScoutChatRequest,
  ScoutTripContext,
  ScoutStreamEvent,
  ScoutChatResponse,
} from '../../server/types/scout.js';
import type { Waypoint } from '../../src/types/routing.js';
import type { ParsedTrip } from '../../src/engine/itineraryParser.js';
import {
  ConverseCommand,
  ConverseStreamCommand,
  type BedrockRuntimeClient,
  type ConverseStreamOutput,
} from '@aws-sdk/client-bedrock-runtime';

// Mock react-dom createPortal so modal renders inline under react-test-renderer
vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return {
    ...actual,
    createPortal: (children: React.ReactNode) => children,
  };
});

const act = renderer.act;
const create = renderer.create;

// Helper to create async generator stream for ConverseStreamCommand mocks
async function* createAsyncStream<T>(chunks: T[]): AsyncIterable<T> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

// Sample test fixtures
const sampleWaypoint: WaypointContext = {
  id: 'wp_sedona_bell_rock',
  name: 'Sedona Red Rock Vistas (Bell Rock)',
  type: 'scenic_pull_off',
  targetTime: '16:30:00',
  formattedTime: '4:30 PM',
  approachHighway: 'AZ-179 North',
  notes: 'Bell Rock scenic pull-off for photo views',
};

const sampleWaypointWithDetails: Waypoint = {
  id: 'wp_sedona_bell_rock',
  name: 'Sedona Red Rock Vistas (Bell Rock)',
  type: 'scenic_pull_off',
  lat: 34.8005,
  lng: -111.7667,
  target_time: '16:30:00',
  dwell_minutes: 20,
  trigger_radius_miles: 2.0,
  approachHighway: 'AZ-179 North',
  notes: 'Bell Rock scenic pull-off for red rock views',
  notification: {
    title: 'Bell Rock Vista Ahead',
    message: 'Arriving at Bell Rock. 20-min scenic stop.',
    speech: 'Approaching Bell Rock Scenic Vista on Highway 179.',
  },
};

const sampleTripContext: ScoutTripContext = {
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

const sampleTrip: ParsedTrip = {
  tripName: 'Phoenix to Sedona Scenic Run',
  days: [
    {
      dayNumber: 1,
      title: 'Day 1: Red Rock Scenic Byway',
      date: '2026-10-10',
      origin: 'Phoenix, AZ',
      destination: 'Sedona, AZ',
      departureTime: '08:00:00',
      waypoints: [sampleWaypointWithDetails],
    },
  ],
};

const sampleTools: ToolDeclaration[] = [
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

describe('Adversarial Bedrock Adapter & Configurable Model Selection Suite', () => {
  describe('1. AwsBedrockHarnessAdapter Unit Tests (server/services/bedrockService.ts)', () => {
    describe('Catalog & Defaults (ADR-0010)', () => {
      it('verifies DEFAULT_BEDROCK_SCOUT_MODEL_ID and DEFAULT_BEDROCK_COPYWRITER_MODEL_ID match ADR-0010', () => {
        expect(DEFAULT_BEDROCK_SCOUT_MODEL_ID).toBe('us.moonshotai.kimi-k3');
        expect(DEFAULT_BEDROCK_COPYWRITER_MODEL_ID).toBe('us.amazon.nova-2-lite-v1:0');
        expect(MAX_TOOL_ITERATIONS).toBe(5);
      });

      it('verifies BEDROCK_MODEL_CATALOG contains 18 models with valid id, name, provider, description, and role', () => {
        expect(BEDROCK_MODEL_CATALOG).toHaveLength(18);

        for (const model of BEDROCK_MODEL_CATALOG) {
          expect(typeof model.id).toBe('string');
          expect(model.id.length).toBeGreaterThan(0);

          expect(typeof model.name).toBe('string');
          expect(model.name.length).toBeGreaterThan(0);

          expect(typeof model.provider).toBe('string');
          expect(model.provider.length).toBeGreaterThan(0);

          expect(typeof model.description).toBe('string');
          expect(model.description.length).toBeGreaterThan(0);

          expect(['scout', 'copywriter', 'both']).toContain(model.role);
        }

        // Verify key flagship defaults are present in catalog
        const scoutModel = BEDROCK_MODEL_CATALOG.find((m) => m.id === DEFAULT_BEDROCK_SCOUT_MODEL_ID);
        expect(scoutModel).toBeDefined();
        expect(scoutModel?.provider).toBe('Moonshot AI');

        const copywriterModel = BEDROCK_MODEL_CATALOG.find((m) => m.id === DEFAULT_BEDROCK_COPYWRITER_MODEL_ID);
        expect(copywriterModel).toBeDefined();
        expect(copywriterModel?.provider).toBe('Amazon');
      });

      it('getModelCatalog() returns complete catalog and active configured defaults', () => {
        const adapter = new AwsBedrockHarnessAdapter({
          scoutModelId: 'us.amazon.nova-pro-v1:0',
          copywriterModelId: 'us.amazon.nova-2-lite-v1:0',
        });

        const catalog = adapter.getModelCatalog();
        expect(catalog.models).toEqual(BEDROCK_MODEL_CATALOG);
        expect(catalog.defaultScoutModelId).toBe('us.amazon.nova-pro-v1:0');
        expect(catalog.defaultCopywriterModelId).toBe('us.amazon.nova-2-lite-v1:0');
      });

      it('supports constructor options and environment variables with alias normalization for defaults', () => {
        const prevScout = process.env.BEDROCK_SCOUT_MODEL_ID;
        const prevCopy = process.env.BEDROCK_COPYWRITER_MODEL_ID;
        try {
          process.env.BEDROCK_SCOUT_MODEL_ID = 'moonshotai.kimi-k3';
          process.env.BEDROCK_COPYWRITER_MODEL_ID = 'amazon.nova-2-lite-v1:0';

          const adapter = new AwsBedrockHarnessAdapter();
          expect(adapter.defaultScoutModelId).toBe('us.moonshotai.kimi-k3');
          expect(adapter.defaultCopywriterModelId).toBe('us.amazon.nova-2-lite-v1:0');
        } finally {
          if (prevScout !== undefined) process.env.BEDROCK_SCOUT_MODEL_ID = prevScout;
          else delete process.env.BEDROCK_SCOUT_MODEL_ID;
          if (prevCopy !== undefined) process.env.BEDROCK_COPYWRITER_MODEL_ID = prevCopy;
          else delete process.env.BEDROCK_COPYWRITER_MODEL_ID;
        }
      });
    });

    describe('Model Allowlist & Alias Normalization (validateModelId)', () => {
      const adapter = new AwsBedrockHarnessAdapter({ available: true });

      it('normalizes bare foundation model IDs to their us. inference profiles', () => {
        expect(adapter.validateModelId('moonshotai.kimi-k3')).toBe('us.moonshotai.kimi-k3');
        expect(adapter.validateModelId('amazon.nova-2-lite-v1:0')).toBe('us.amazon.nova-2-lite-v1:0');
        expect(adapter.validateModelId('amazon.nova-pro-v1:0')).toBe('us.amazon.nova-pro-v1:0');
        expect(adapter.validateModelId('openai.gpt-6-luna')).toBe('us.openai.gpt-6-luna');
        expect(adapter.validateModelId('anthropic.claude-sonnet-5-5')).toBe('us.anthropic.claude-sonnet-5-5');
        expect(adapter.validateModelId('xai.grok-4.7')).toBe('us.xai.grok-4.7');
      });

      it('accepts direct on-demand models and additional allowed IDs', () => {
        expect(adapter.validateModelId('openai.gpt-oss-120b-1:0')).toBe('openai.gpt-oss-120b-1:0');
        expect(adapter.validateModelId('deepseek.v3.2')).toBe('deepseek.v3.2');
        expect(adapter.validateModelId('mistral.mistral-large-3-675b-instruct')).toBe('mistral.mistral-large-3-675b-instruct');
        expect(adapter.validateModelId('moonshotai.kimi-k2.5')).toBe('moonshotai.kimi-k2.5');
        expect(adapter.validateModelId('amazon.nova-lite-v1:0')).toBe('amazon.nova-lite-v1:0');
        expect(adapter.validateModelId('us.amazon.nova-lite-v1:0')).toBe('us.amazon.nova-lite-v1:0');
      });

      it('rejects empty string, whitespace, and unknown model IDs with InvalidModelError (HTTP 400)', () => {
        expect(() => adapter.validateModelId('')).toThrow(InvalidModelError);
        expect(() => adapter.validateModelId('   ')).toThrow(InvalidModelError);
        expect(() => adapter.validateModelId('unknown-model-xyz')).toThrow(InvalidModelError);

        try {
          adapter.validateModelId('unknown-model-xyz');
        } catch (err: unknown) {
          expect(err).toBeInstanceOf(InvalidModelError);
          expect((err as InvalidModelError).statusCode).toBe(400);
          expect((err as InvalidModelError).message).toContain('Unsupported Bedrock model ID');
        }

        try {
          adapter.validateModelId('');
        } catch (err: unknown) {
          expect(err).toBeInstanceOf(InvalidModelError);
          expect((err as InvalidModelError).statusCode).toBe(400);
          expect((err as InvalidModelError).message).toContain('Model ID must not be empty');
        }
      });
    });

    describe('Region Resolution (Negative Constraint Verification)', () => {
      const origRegion = process.env.AWS_REGION;
      const origDefRegion = process.env.AWS_DEFAULT_REGION;

      afterEach(() => {
        if (origRegion !== undefined) process.env.AWS_REGION = origRegion;
        else delete process.env.AWS_REGION;
        if (origDefRegion !== undefined) process.env.AWS_DEFAULT_REGION = origDefRegion;
        else delete process.env.AWS_DEFAULT_REGION;
      });

      it('respects options.region (e.g. us-east-2) and never hardcodes us-east-1', async () => {
        delete process.env.AWS_REGION;
        delete process.env.AWS_DEFAULT_REGION;

        const adapter = new AwsBedrockHarnessAdapter({ region: 'us-east-2' });
        const client = (adapter as unknown as { client: BedrockRuntimeClient }).client;
        const resolvedRegion = await client.config.region();

        expect(resolvedRegion).toBe('us-east-2');
        expect(resolvedRegion).not.toBe('us-east-1');
      });

      it('respects process.env.AWS_REGION (us-east-2) when no explicit option is provided', async () => {
        process.env.AWS_REGION = 'us-east-2';
        delete process.env.AWS_DEFAULT_REGION;

        const adapter = new AwsBedrockHarnessAdapter();
        const client = (adapter as unknown as { client: BedrockRuntimeClient }).client;
        const resolvedRegion = await client.config.region();

        expect(resolvedRegion).toBe('us-east-2');
      });

      it('respects alternative non-default region (e.g. eu-west-1)', async () => {
        const adapter = new AwsBedrockHarnessAdapter({ region: 'eu-west-1' });
        const client = (adapter as unknown as { client: BedrockRuntimeClient }).client;
        const resolvedRegion = await client.config.region();

        expect(resolvedRegion).toBe('eu-west-1');
      });
    });

    describe('isAvailable()', () => {
      it('returns true when a custom client is injected or available option is true', async () => {
        const mockClient = { send: vi.fn() } as unknown as BedrockRuntimeClient;
        const adapterWithClient = new AwsBedrockHarnessAdapter({ client: mockClient });
        expect(await adapterWithClient.isAvailable()).toBe(true);

        const adapterWithAvail = new AwsBedrockHarnessAdapter({ available: true });
        expect(await adapterWithAvail.isAvailable()).toBe(true);
      });

      it('returns false when available option is explicitly false without custom client', async () => {
        const adapter = new AwsBedrockHarnessAdapter({ available: false });
        expect(await adapter.isAvailable()).toBe(false);
      });
    });

    describe('sanitizeBedrockResponse & Tool Formatting Helpers', () => {
      it('strips closed and unclosed thinking tags and harness noise', () => {
        expect(
          sanitizeBedrockResponse(
            '<thinking>Reasoning here</thinking>Stop at Bell Rock for scenic views.'
          )
        ).toBe('Stop at Bell Rock for scenic views.');

        expect(
          sanitizeBedrockResponse(
            '<think>Reasoning here</think>Stop at Bell Rock for scenic views.'
          )
        ).toBe('Stop at Bell Rock for scenic views.');

        expect(
          sanitizeBedrockResponse(
            'Stop at Bell Rock for scenic views.<thinking>Unclosed internal thoughts...'
          )
        ).toBe('Stop at Bell Rock for scenic views.');

        expect(
          sanitizeBedrockResponse(
            'Wait for the background task to complete. Stop at Bell Rock.'
          )
        ).toBe('Stop at Bell Rock.');

        expect(
          sanitizeBedrockResponse(
            'Stop at Bell Rock.\n\nI have attached this as a candidate update.'
          )
        ).toBe('Stop at Bell Rock.');

        expect(
          sanitizeBedrockResponse(
            'Stop at Bell Rock scenic overlook.</thinking>'
          )
        ).toBe('Stop at Bell Rock scenic overlook.');

        expect(
          sanitizeBedrockResponse(
            'Stop at Bell Rock scenic overlook.</think>'
          )
        ).toBe('Stop at Bell Rock scenic overlook.');
      });

      it('formats tool labels correctly for search_web and read_url_content', () => {
        expect(formatBedrockToolLabel('search_web', { query: 'Sedona pull offs' }, false)).toBe(
          'Searching web: "Sedona pull offs"'
        );
        expect(formatBedrockToolLabel('search_web', { query: 'Sedona pull offs' }, true)).toBe(
          'Searched web for "Sedona pull offs"'
        );
        expect(formatBedrockToolLabel('search_web', {}, false)).toBe('Searching the web...');
        expect(formatBedrockToolLabel('search_web', {}, true)).toBe('Completed web search');

        expect(
          formatBedrockToolLabel('read_url_content', { Url: 'https://azdot.gov/sedona' }, false)
        ).toBe('Reading content from azdot.gov');
        expect(
          formatBedrockToolLabel('read_url_content', { Url: 'https://azdot.gov/sedona' }, true)
        ).toBe('Read content from azdot.gov');

        expect(formatBedrockToolLabel('calculate_detour', {}, false)).toBe(
          'Running calculate detour...'
        );
        expect(formatBedrockToolLabel('calculate_detour', {}, true)).toBe(
          'Completed calculate detour'
        );
      });
    });

    describe('generate() (ConverseCommand)', () => {
      it('sends ConverseCommand with defaultCopywriterModelId by default or normalized options.modelId', async () => {
        const mockSend = vi.fn().mockResolvedValue({
          output: {
            message: {
              content: [
                {
                  text: '{"title":"Bell Rock Ahead","message":"Scenic view","speech":"Approaching Bell Rock"}',
                },
              ],
            },
          },
        });

        const mockClient = { send: mockSend } as unknown as BedrockRuntimeClient;
        const adapter = new AwsBedrockHarnessAdapter({ client: mockClient });

        // 1. Default model call
        const resDefault = await adapter.generate('Generate alert prompt');
        expect(resDefault).toContain('Bell Rock Ahead');
        expect(mockSend).toHaveBeenCalledTimes(1);
        const firstCallCommand = mockSend.mock.calls[0][0] as ConverseCommand;
        expect(firstCallCommand.input.modelId).toBe('us.amazon.nova-2-lite-v1:0');

        // 2. Custom model call with alias normalization
        await adapter.generate('Generate alert prompt', {
          modelId: 'amazon.nova-pro-v1:0',
        });
        expect(mockSend).toHaveBeenCalledTimes(2);
        const secondCallCommand = mockSend.mock.calls[1][0] as ConverseCommand;
        expect(secondCallCommand.input.modelId).toBe('us.amazon.nova-pro-v1:0');
      });

      it('strips <thinking> tags from returned text via sanitizeBedrockResponse', async () => {
        const mockSend = vi.fn().mockResolvedValue({
          output: {
            message: {
              content: [
                {
                  text: '<thinking>Internal thought chain</thinking>Scenic overlook alert: Bell Rock.',
                },
              ],
            },
          },
        });

        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
        });

        const res = await adapter.generate('Alert prompt');
        expect(res).toBe('Scenic overlook alert: Bell Rock.');
        expect(res).not.toContain('<thinking>');
        expect(res).not.toContain('Internal thought chain');
      });

      it('throws an error if Bedrock returns empty text content', async () => {
        const mockSend = vi.fn().mockResolvedValue({
          output: {
            message: {
              content: [],
            },
          },
        });

        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
        });

        await expect(adapter.generate('Prompt')).rejects.toThrow(
          'AI provider returned an empty response'
        );
      });
    });

    describe('generateStreamWithTools() (ConverseStreamCommand)', () => {
      it('Single-turn streaming + reasoning & split <thinking> tag hygiene', async () => {
        const streamChunks: ConverseStreamOutput[] = [
          {
            contentBlockDelta: {
              delta: { reasoningContent: { text: 'Internal chain of thought' } },
            },
          },
          {
            contentBlockDelta: {
              delta: { text: '<thi' },
            },
          },
          {
            contentBlockDelta: {
              delta: { text: 'nking>Secret Nova reasoning</thinking>Hello ' },
            },
          },
          {
            contentBlockDelta: {
              delta: { text: 'driver!' },
            },
          },
          {
            messageStop: {
              stopReason: 'end_turn',
            },
          },
          {
            metadata: {
              usage: { inputTokens: 120, outputTokens: 45 },
            },
          },
        ];

        const mockSend = vi.fn().mockResolvedValue({
          stream: createAsyncStream(streamChunks),
        });

        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
        });

        const emittedEvents: ScoutStreamEvent[] = [];
        const result = await adapter.generateStreamWithTools(
          'Audit prompt',
          [],
          vi.fn(),
          (evt) => emittedEvents.push(evt)
        );

        // 1. Verify thought event was emitted for reasoningContent
        const thoughtEvents = emittedEvents.filter((e) => e.event === 'thought');
        expect(thoughtEvents).toHaveLength(1);
        expect(thoughtEvents[0].data.text).toBe('Reasoning through route options...');

        // 2. Verify delta chunks concatenated equal 'Hello driver!' without leaking '<thi' or reasoning
        const deltaEvents = emittedEvents.filter((e) => e.event === 'delta');
        const concatenatedDelta = deltaEvents.map((e) => e.data.text).join('');
        expect(concatenatedDelta).toBe('Hello driver!');
        expect(concatenatedDelta).not.toContain('<thi');
        expect(concatenatedDelta).not.toContain('Secret Nova reasoning');

        // 3. Verify final result tokens and text
        expect(result).toEqual({
          text: 'Hello driver!',
          inputTokens: 120,
          outputTokens: 45,
        });
      });

      it('Multi-turn parallel tool execution loop (Promise.all)', async () => {
        // Turn 1 stream: requests two tools in parallel
        const turn1Stream: ConverseStreamOutput[] = [
          {
            contentBlockStart: {
              contentBlockIndex: 0,
              start: { toolUse: { toolUseId: 'call_1', name: 'search_web' } },
            },
          },
          {
            contentBlockDelta: {
              contentBlockIndex: 0,
              delta: { toolUse: { input: '{"query":"Sedona pull offs"}' } },
            },
          },
          {
            contentBlockStart: {
              contentBlockIndex: 1,
              start: { toolUse: { toolUseId: 'call_2', name: 'read_url_content' } },
            },
          },
          {
            contentBlockDelta: {
              contentBlockIndex: 1,
              delta: { toolUse: { input: '{"Url":"https://azdot.gov/sedona"}' } },
            },
          },
          {
            messageStop: { stopReason: 'tool_use' },
          },
          {
            metadata: { usage: { inputTokens: 100, outputTokens: 50 } },
          },
        ];

        // Turn 2 stream: returns final answer
        const turn2Stream: ConverseStreamOutput[] = [
          {
            contentBlockDelta: {
              delta: { text: 'Found great pull-offs on AZ-179.' },
            },
          },
          {
            messageStop: { stopReason: 'end_turn' },
          },
          {
            metadata: { usage: { inputTokens: 200, outputTokens: 80 } },
          },
        ];

        const mockSend = vi
          .fn()
          .mockResolvedValueOnce({ stream: createAsyncStream(turn1Stream) })
          .mockResolvedValueOnce({ stream: createAsyncStream(turn2Stream) });

        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
        });

        const mockDispatcher = vi.fn().mockImplementation(async (name: string, args: Record<string, unknown>) => {
          if (name === 'search_web') return { results: ['Bell Rock vista pull-off'] };
          if (name === 'read_url_content') return { content: 'AZDOT scenic highway 179 guide' };
          return {};
        });

        const emittedEvents: ScoutStreamEvent[] = [];
        const result = await adapter.generateStreamWithTools(
          'Find scenic pull offs',
          sampleTools,
          mockDispatcher,
          (evt) => emittedEvents.push(evt)
        );

        // Verify dispatcher was invoked for both tools in parallel
        expect(mockDispatcher).toHaveBeenCalledTimes(2);
        expect(mockDispatcher).toHaveBeenCalledWith('search_web', { query: 'Sedona pull offs' });
        expect(mockDispatcher).toHaveBeenCalledWith('read_url_content', {
          Url: 'https://azdot.gov/sedona',
        });

        // Verify activity events (state: 'active' then state: 'done' with durationSeconds)
        const activityEvents = emittedEvents.filter((e) => e.event === 'activity');
        expect(activityEvents.length).toBe(4); // 2 active + 2 done

        const activeCalls = activityEvents.filter((e) => e.data.state === 'active');
        expect(activeCalls.map((a) => a.data.id)).toEqual(['call_1', 'call_2']);

        const doneCalls = activityEvents.filter((e) => e.data.state === 'done');
        expect(doneCalls.map((d) => d.data.id)).toEqual(['call_1', 'call_2']);
        expect(doneCalls[0].data.durationSeconds).toBeGreaterThanOrEqual(0);
        expect(doneCalls[1].data.durationSeconds).toBeGreaterThanOrEqual(0);

        // Verify Turn 2 ConverseStreamCommand messages
        expect(mockSend).toHaveBeenCalledTimes(2);
        const turn2Command = mockSend.mock.calls[1][0] as ConverseStreamCommand;
        const messages = turn2Command.input.messages!;
        expect(messages).toHaveLength(3); // user prompt -> assistant toolUse -> user toolResult

        const assistantMsg = messages[1];
        expect(assistantMsg.role).toBe('assistant');
        expect(assistantMsg.content).toEqual([
          {
            toolUse: {
              toolUseId: 'call_1',
              name: 'search_web',
              input: { query: 'Sedona pull offs' },
            },
          },
          {
            toolUse: {
              toolUseId: 'call_2',
              name: 'read_url_content',
              input: { Url: 'https://azdot.gov/sedona' },
            },
          },
        ]);

        const userToolResultMsg = messages[2];
        expect(userToolResultMsg.role).toBe('user');
        expect(userToolResultMsg.content).toEqual([
          {
            toolResult: {
              toolUseId: 'call_1',
              content: [{ json: { results: ['Bell Rock vista pull-off'] } }],
              status: 'success',
            },
          },
          {
            toolResult: {
              toolUseId: 'call_2',
              content: [{ json: { content: 'AZDOT scenic highway 179 guide' } }],
              status: 'success',
            },
          },
        ]);

        // Verify cumulative tokens: 100+200=300 input, 50+80=130 output
        expect(result).toEqual({
          text: 'Found great pull-offs on AZ-179.',
          inputTokens: 300,
          outputTokens: 130,
        });
      });

      it('Tool dispatcher error recovery: catches errors, emits state: error, and recovers in Turn 2', async () => {
        const turn1Stream: ConverseStreamOutput[] = [
          {
            contentBlockStart: {
              contentBlockIndex: 0,
              start: { toolUse: { toolUseId: 'call_err', name: 'search_web' } },
            },
          },
          {
            contentBlockDelta: {
              contentBlockIndex: 0,
              delta: { toolUse: { input: '{"query":"Corridor audit"}' } },
            },
          },
          {
            messageStop: { stopReason: 'tool_use' },
          },
        ];

        const turn2Stream: ConverseStreamOutput[] = [
          {
            contentBlockDelta: {
              delta: { text: 'Recovered from search error. Continuing with route audit.' },
            },
          },
          {
            messageStop: { stopReason: 'end_turn' },
          },
        ];

        const mockSend = vi
          .fn()
          .mockResolvedValueOnce({ stream: createAsyncStream(turn1Stream) })
          .mockResolvedValueOnce({ stream: createAsyncStream(turn2Stream) });

        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
        });

        const failingDispatcher = vi.fn().mockRejectedValue(new Error('Search API 503'));
        const emittedEvents: ScoutStreamEvent[] = [];

        const result = await adapter.generateStreamWithTools(
          'Audit prompt',
          sampleTools,
          failingDispatcher,
          (evt) => emittedEvents.push(evt)
        );

        // Verify activity error event was emitted
        const errActivity = emittedEvents.find(
          (e) => e.event === 'activity' && e.data.state === 'error'
        );
        expect(errActivity).toBeDefined();
        expect(errActivity?.data.id).toBe('call_err');

        // Verify Turn 2 received toolResult with status: 'error' and error message
        const turn2Command = mockSend.mock.calls[1][0] as ConverseStreamCommand;
        const userMsg = turn2Command.input.messages![2];
        expect(userMsg.content).toEqual([
          {
            toolResult: {
              toolUseId: 'call_err',
              content: [{ json: { error: 'Search API 503' } }],
              status: 'error',
            },
          },
        ]);

        expect(result.text).toBe('Recovered from search error. Continuing with route audit.');
      });

      it('MAX_TOOL_ITERATIONS = 5 loop cap: throws explicit error after 5 iterations', async () => {
        const loopingToolStream: ConverseStreamOutput[] = [
          {
            contentBlockStart: {
              contentBlockIndex: 0,
              start: { toolUse: { toolUseId: 'loop_call', name: 'search_web' } },
            },
          },
          {
            contentBlockDelta: {
              contentBlockIndex: 0,
              delta: { toolUse: { input: '{"query":"infinite loop"}' } },
            },
          },
          {
            messageStop: { stopReason: 'tool_use' },
          },
        ];

        const mockSend = vi.fn().mockImplementation(async () => ({
          stream: createAsyncStream(loopingToolStream),
        }));

        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
        });

        const mockDispatcher = vi.fn().mockResolvedValue({ status: 'ok' });

        await expect(
          adapter.generateStreamWithTools(
            'Loop prompt',
            sampleTools,
            mockDispatcher,
            () => {}
          )
        ).rejects.toThrow('Route Scout exceeded maximum tool iterations (5)');

        expect(mockSend).toHaveBeenCalledTimes(5);
      });

      it('AbortSignal mid-stream cancellation: rejects immediately with "Request aborted"', async () => {
        const abortController = new AbortController();

        // Stream that triggers abort during consumption
        async function* createAbortStream(): AsyncIterable<ConverseStreamOutput> {
          yield { contentBlockDelta: { delta: { text: 'Starting analysis...' } } };
          abortController.abort();
          yield { contentBlockDelta: { delta: { text: 'More analysis...' } } };
        }

        const mockSend = vi.fn().mockResolvedValue({
          stream: createAbortStream(),
        });

        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
        });

        await expect(
          adapter.generateStreamWithTools(
            'Abort prompt',
            [],
            vi.fn(),
            () => {},
            { abortSignal: abortController.signal }
          )
        ).rejects.toThrow('Request aborted');
      });
    });
  });

  describe('2. Fastify Endpoints, AiService & ScoutService Integration Tests', () => {
    it('GET /api/ai/status returns available: true, engine: "bedrock", 18 models, and ADR-0010 defaults', async () => {
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string } }) => {
          if (!cmd.input?.modelId) {
            return {
              inferenceProfileSummaries: BEDROCK_MODEL_CATALOG.map((model) => ({
                inferenceProfileId: model.id,
                status: 'ACTIVE',
              })),
            };
          }
          return {
            authorizationStatus: 'AUTHORIZED',
            entitlementAvailability: 'AVAILABLE',
            regionAvailability: 'AVAILABLE',
            agreementAvailability: { status: 'AVAILABLE' },
          };
        }),
      };
      const mockBedrockAdapter = new AwsBedrockHarnessAdapter({
        available: true,
        controlClient: mockControlClient as unknown as BedrockClient,
        client: { send: vi.fn() } as unknown as BedrockRuntimeClient,
      });

      const aiService = new AiService({ adapters: [mockBedrockAdapter] });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({
        method: 'GET',
        url: '/api/ai/status',
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.available).toBe(true);
      expect(data.engine).toBe('bedrock');
      expect(data.models).toHaveLength(18);
      expect(data.defaultScoutModelId).toBe('us.moonshotai.kimi-k3');
      expect(data.defaultCopywriterModelId).toBe('us.amazon.nova-2-lite-v1:0');
    });

    it('POST /api/copilot/generate uses Bedrock when available and forwards normalized modelId', async () => {
      const mockGenerate = vi.fn().mockResolvedValue(
        JSON.stringify({
          title: 'Sedona Red Rocks Ahead',
          message: 'Target arrival: 4:30 PM.\nRecommended stop.',
          speech: 'Upcoming sight on your right: Bell Rock.',
          recommended_trigger_radius_miles: 2.0,
        })
      );

      const mockBedrockAdapter: AiHarnessAdapter = {
        id: 'bedrock',
        name: 'Amazon Bedrock',
        getAvailableModels: async () => [],
        getModelCatalog: () => ({
          models: [],
          defaultScoutModelId: 'test-scout-model',
          defaultCopywriterModelId: 'test-copywriter-model',
        }),
        decorateScoutPrompt: (prompt: string) => prompt,
        sanitizeResponse: (text: string) => text,
        isAvailable: vi.fn().mockResolvedValue(true),
        generate: mockGenerate,
        validateModelId: (m: string) =>
          new AwsBedrockHarnessAdapter({ available: true }).validateModelId(m),
      };

      const aiService = new AiService({ adapters: [mockBedrockAdapter] });
      const app = createApp({ logger: false, aiService });

      // Single waypoint generation with model alias
      const resSingle = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoint: sampleWaypoint,
          modelId: 'amazon.nova-2-lite-v1:0',
        },
      });

      expect(resSingle.statusCode).toBe(200);
      const singleData = resSingle.json();
      expect(singleData.engine).toBe('bedrock');
      expect(singleData.title).toBe('Sedona Red Rocks Ahead');
      expect(mockGenerate).toHaveBeenCalledTimes(1);
      expect(mockGenerate.mock.calls[0][1]).toEqual(
        expect.objectContaining({
          modelId: 'us.amazon.nova-2-lite-v1:0',
        })
      );

      // Batch waypoints generation
      mockGenerate.mockResolvedValueOnce(
        JSON.stringify({
          wp_sedona_bell_rock: {
            title: 'Batch Bell Rock',
            message: 'Batch message',
            speech: 'Batch speech',
            recommended_trigger_radius_miles: 2.5,
          },
        })
      );

      const resBatch = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoints: [sampleWaypoint],
          modelId: 'amazon.nova-2-lite-v1:0',
        },
      });

      expect(resBatch.statusCode).toBe(200);
      const batchData = resBatch.json();
      expect(batchData.engine).toBe('bedrock');
      expect(batchData.alerts.wp_sedona_bell_rock.title).toBe('Batch Bell Rock');
      expect(mockGenerate.mock.calls[1][1]).toEqual(
        expect.objectContaining({
          modelId: 'us.amazon.nova-2-lite-v1:0',
        })
      );
    });

    it('POST /api/copilot/day-title uses Bedrock and forwards normalized modelId', async () => {
      const mockGenerate = vi.fn().mockResolvedValue(
        JSON.stringify({
          title: 'Red Rock Canyon Odyssey',
        })
      );

      const mockBedrockAdapter: AiHarnessAdapter = {
        id: 'bedrock',
        name: 'Amazon Bedrock',
        getAvailableModels: async () => [],
        getModelCatalog: () => ({
          models: [],
          defaultScoutModelId: 'test-scout-model',
          defaultCopywriterModelId: 'test-copywriter-model',
        }),
        decorateScoutPrompt: (prompt: string) => prompt,
        sanitizeResponse: (text: string) => text,
        isAvailable: vi.fn().mockResolvedValue(true),
        generate: mockGenerate,
        validateModelId: (m: string) =>
          new AwsBedrockHarnessAdapter({ available: true }).validateModelId(m),
      };

      const aiService = new AiService({ adapters: [mockBedrockAdapter] });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({
        method: 'POST',
        url: '/api/copilot/day-title',
        payload: {
          dayNumber: 1,
          stops: [{ name: 'Phoenix' }, { name: 'Sedona' }],
          modelId: 'amazon.nova-2-lite-v1:0',
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.engine).toBe('bedrock');
      expect(data.title).toBe('Red Rock Canyon Odyssey');
      expect(mockGenerate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          modelId: 'us.amazon.nova-2-lite-v1:0',
        })
      );
    });

    it('POST /api/copilot/generate and /day-title return HTTP 400 when modelId is unknown or empty', async () => {
      const app = createApp({ logger: false });

      // 1. Single waypoint with unknown modelId
      const resUnknownSingle = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoint: sampleWaypoint,
          modelId: 'bad-model',
        },
      });
      expect(resUnknownSingle.statusCode).toBe(400);
      expect(resUnknownSingle.json().error).toContain('Unsupported Bedrock model ID');

      // 2. Single waypoint with empty modelId
      const resEmptySingle = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoint: sampleWaypoint,
          modelId: '',
        },
      });
      expect(resEmptySingle.statusCode).toBe(400);
      expect(resEmptySingle.json().error).toContain('Model ID must not be empty');

      // 3. Batch waypoints with bad modelId
      const resBadBatch = await app.inject({
        method: 'POST',
        url: '/api/copilot/generate',
        payload: {
          waypoints: [sampleWaypoint],
          modelId: 'bad-model',
        },
      });
      expect(resBadBatch.statusCode).toBe(400);

      // 4. Day title with bad modelId
      const resBadTitle = await app.inject({
        method: 'POST',
        url: '/api/copilot/day-title',
        payload: {
          dayNumber: 1,
          stops: [{ name: 'Phoenix' }],
          modelId: 'bad-model',
        },
      });
      expect(resBadTitle.statusCode).toBe(400);
    });

    it('POST /api/ai/scout/chat and chat/stream return HTTP 400 when modelId is unknown or empty', async () => {
      const app = createApp({ logger: false });

      // 1. Non-streaming chat with bad modelId
      const resBadChat = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat',
        payload: {
          scope: { type: 'day', dayNumber: 1 },
          messages: [{ role: 'user', content: 'Audit my route' }],
          tripContext: sampleTripContext,
          modelId: 'bad-model',
        },
      });
      expect(resBadChat.statusCode).toBe(400);
      expect(resBadChat.json().error).toContain('Unsupported Bedrock model ID');

      // 2. Non-streaming chat with empty modelId
      const resEmptyChat = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat',
        payload: {
          scope: { type: 'day', dayNumber: 1 },
          messages: [{ role: 'user', content: 'Audit my route' }],
          tripContext: sampleTripContext,
          modelId: '',
        },
      });
      expect(resEmptyChat.statusCode).toBe(400);

      // 3. Streaming chat with bad modelId
      const resBadStream = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat/stream',
        payload: {
          scope: { type: 'day', dayNumber: 1 },
          messages: [{ role: 'user', content: 'Audit my route' }],
          tripContext: sampleTripContext,
          modelId: 'bad-model',
        },
      });
      expect(resBadStream.statusCode).toBe(400);
      expect(resBadStream.json().error).toContain('Unsupported Bedrock model ID');

      // 4. Streaming chat with empty modelId
      const resEmptyStream = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat/stream',
        payload: {
          scope: { type: 'day', dayNumber: 1 },
          messages: [{ role: 'user', content: 'Audit my route' }],
          tripContext: sampleTripContext,
          modelId: '',
        },
      });
      expect(resEmptyStream.statusCode).toBe(400);
    });

    it('POST /api/ai/scout/chat/stream emits : ping, periodic : keep-alive, event: delta, and event: done', async () => {
      // Mock Bedrock adapter where generateStreamWithTools delays 40ms to trigger keep-alive timer at 15ms interval
      const mockBedrockAdapter: AiHarnessAdapter = {
        id: 'bedrock',
        name: 'Amazon Bedrock',
        getAvailableModels: async () => [],
        getModelCatalog: () => ({
          models: [],
          defaultScoutModelId: 'test-scout-model',
          defaultCopywriterModelId: 'test-copywriter-model',
        }),
        decorateScoutPrompt: (prompt: string) => prompt,
        sanitizeResponse: (text: string) => text,
        isAvailable: vi.fn().mockResolvedValue(true),
        generate: vi.fn(),
        validateModelId: (m: string) =>
          new AwsBedrockHarnessAdapter({ available: true }).validateModelId(m),
        generateStreamWithTools: vi.fn().mockImplementation(
          async (_prompt, _tools, _dispatcher, onChunk) => {
            // Wait 40ms so that keepAliveIntervalMs: 15 fires keep-alive comments
            await new Promise((resolve) => setTimeout(resolve, 40));
            onChunk({
              event: 'delta',
              data: { text: '### Route Analysis\n\nSedona corridor looks clear.' },
            });
            return {
              text: '### Route Analysis\n\nSedona corridor looks clear.',
              inputTokens: 150,
              outputTokens: 60,
            };
          }
        ),
      };

      const aiService = new AiService({ adapters: [mockBedrockAdapter] });
      const scoutService = new ScoutService({ aiService });

      const app = createApp({
        logger: false,
        aiService,
        scoutService,
        keepAliveIntervalMs: 15,
      });
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

      const res = await app.inject({
        method: 'POST',
        url: '/api/ai/scout/chat/stream',
        payload: {
          scope: { type: 'day', dayNumber: 1 },
          messages: [{ role: 'user', content: 'Audit Sedona stops' }],
          tripContext: sampleTripContext,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');

      const body = res.body;

      // 1. Must start with immediate ping
      expect(body.startsWith(': ping\n\n')).toBe(true);

      // 2. Must contain at least one periodic keep-alive heartbeat comment
      expect(body).toContain(': keep-alive\n\n');

      // 3. Must contain delta event
      expect(body).toContain('event: delta\n');
      expect(body).toContain('Sedona corridor looks clear.');

      // 4. Must contain done event with engine: "bedrock"
      expect(body).toContain('event: done\n');
      expect(body).toContain('"engine":"bedrock"');

      // 5. Keep-alive timer is cleared when the stream completes
      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });

    it('POST /api/ai/scout/chat/stream emits a single event: error without duplication on failure', async () => {
      const mockBedrockAdapter: AiHarnessAdapter = {
        id: 'bedrock',
        name: 'Amazon Bedrock',
        getAvailableModels: async () => [],
        getModelCatalog: () => ({
          models: [],
          defaultScoutModelId: 'test-scout-model',
          defaultCopywriterModelId: 'test-copywriter-model',
        }),
        decorateScoutPrompt: (prompt: string) => prompt,
        sanitizeResponse: (text: string) => text,
        isAvailable: vi.fn().mockResolvedValue(true),
        generate: vi.fn(),
        validateModelId: (m: string) =>
          new AwsBedrockHarnessAdapter({ available: true }).validateModelId(m),
        generateStreamWithTools: vi.fn().mockRejectedValue(new Error('ValidationException: Error 002')),
      };

      const aiService = new AiService({ adapters: [mockBedrockAdapter] });
      const scoutService = new ScoutService(aiService);
      const app = createApp({ logger: false, scoutService });
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

      try {
        const res = await app.inject({
          method: 'POST',
          url: '/api/ai/scout/chat/stream',
          payload: {
            scope: { type: 'day', dayNumber: 1 },
            messages: [{ role: 'user', content: 'Audit Sedona stops' }],
            tripContext: sampleTripContext,
          },
        });

        expect(res.statusCode).toBe(200);
        const body = res.body;
        const errorMatches = body.match(/event: error/g);
        expect(errorMatches).toHaveLength(1);
        expect(body).toContain('ValidationException: Error 002');
        expect(clearIntervalSpy).toHaveBeenCalled();
      } finally {
        clearIntervalSpy.mockRestore();
      }
    });

    it('aborts upstream work and clears the keep-alive timer when the client disconnects', async () => {
      let capturedSignal: AbortSignal | undefined;
      const mockBedrockAdapter: AiHarnessAdapter = {
        id: 'bedrock',
        name: 'Amazon Bedrock',
        getAvailableModels: async () => [],
        getModelCatalog: () => ({
          models: [],
          defaultScoutModelId: 'test-scout-model',
          defaultCopywriterModelId: 'test-copywriter-model',
        }),
        decorateScoutPrompt: (prompt: string) => prompt,
        sanitizeResponse: (text: string) => text,
        isAvailable: vi.fn().mockResolvedValue(true),
        generate: vi.fn(),
        validateModelId: (m: string) =>
          new AwsBedrockHarnessAdapter({ available: true }).validateModelId(m),
        generateStreamWithTools: vi.fn().mockImplementation(
          (
            _prompt: string,
            _tools: unknown,
            _dispatcher: unknown,
            _onChunk: unknown,
            options?: { abortSignal?: AbortSignal }
          ) =>
            new Promise((_resolve, reject) => {
              capturedSignal = options?.abortSignal;
              options?.abortSignal?.addEventListener('abort', () =>
                reject(new Error('Request aborted'))
              );
            })
        ),
      };

      const aiService = new AiService({ adapters: [mockBedrockAdapter] });
      const scoutService = new ScoutService(aiService);
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      const app = createApp({
        logger: false,
        aiService,
        scoutService,
        keepAliveIntervalMs: 10,
      });
      await app.listen({ port: 0, host: '127.0.0.1' });

      try {
        const address = app.server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const abortController = new AbortController();
        const res = await fetch(`http://127.0.0.1:${port}/api/ai/scout/chat/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: { type: 'day', dayNumber: 1 },
            messages: [{ role: 'user', content: 'Audit Sedona stops' }],
            tripContext: sampleTripContext,
          }),
          signal: abortController.signal,
        });
        expect(res.status).toBe(200);

        const reader = res.body?.getReader();
        expect(reader).toBeDefined();
        await reader!.read(); // consume the immediate `: ping` frame

        for (let i = 0; i < 100 && !capturedSignal; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(capturedSignal).toBeDefined();
        expect(capturedSignal?.aborted).toBe(false);

        abortController.abort();
        await reader!.read().catch(() => undefined);

        for (let i = 0; i < 100 && !capturedSignal?.aborted; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(capturedSignal?.aborted).toBe(true);

        for (let i = 0; i < 100 && clearIntervalSpy.mock.calls.length === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(clearIntervalSpy).toHaveBeenCalled();
      } finally {
        clearIntervalSpy.mockRestore();
        await app.close();
      }
    });

    it('AwsBedrockHarnessAdapter halts immediately and does not retry when abortSignal is aborted', async () => {
      const abortController = new AbortController();
      abortController.abort();

      const adapter = new AwsBedrockHarnessAdapter({
        client: {
          send: vi.fn(),
        } as unknown as BedrockRuntimeClient,
      });

      await expect(
        adapter.generate('Test prompt', { abortSignal: abortController.signal })
      ).rejects.toThrow('Request aborted');

      await expect(
        adapter.generateStreamWithTools(
          'Test prompt',
          [],
          vi.fn(),
          vi.fn(),
          { abortSignal: abortController.signal }
        )
      ).rejects.toThrow('Request aborted');
    });

    it('maps inference profile IDs to foundation model IDs for availability checks', () => {
      expect(toFoundationModelId('us.moonshotai.kimi-k3')).toBe('moonshotai.kimi-k3');
      expect(toFoundationModelId('us.amazon.nova-2-lite-v1:0')).toBe('amazon.nova-2-lite-v1:0');
      expect(toFoundationModelId('eu.anthropic.claude-sonnet-4-6')).toBe('anthropic.claude-sonnet-4-6');
      expect(toFoundationModelId('apac.amazon.nova-pro-v1:0')).toBe('amazon.nova-pro-v1:0');
      expect(toFoundationModelId('deepseek.v3.2')).toBe('deepseek.v3.2');
    });

    it('filters the catalog using active inference profiles and foundation model availability', async () => {
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string } }) => {
          const modelId = cmd.input?.modelId;
          if (!modelId) {
            return {
              inferenceProfileSummaries: [
                { inferenceProfileId: 'us.moonshotai.kimi-k3', status: 'ACTIVE' },
                { inferenceProfileId: 'us.amazon.nova-2-lite-v1:0', status: 'ACTIVE' },
              ],
            };
          }
          if (modelId === 'moonshotai.kimi-k3' || modelId === 'amazon.nova-2-lite-v1:0') {
            return {
              authorizationStatus: 'AUTHORIZED',
              entitlementAvailability: 'AVAILABLE',
              regionAvailability: 'AVAILABLE',
              agreementAvailability: { status: 'AVAILABLE' },
            };
          }
          return {
            authorizationStatus: 'AUTHORIZED',
            entitlementAvailability: 'NOT_AVAILABLE',
            regionAvailability: 'AVAILABLE',
            agreementAvailability: { status: 'NOT_AVAILABLE' },
          };
        }),
      };

      const adapter = new AwsBedrockHarnessAdapter({
        controlClient: mockControlClient as unknown as BedrockClient,
        client: {} as unknown as BedrockRuntimeClient,
      });

      const available = await adapter.getAvailableModels();
      expect(available.map((m) => m.id)).toEqual([
        'us.moonshotai.kimi-k3',
        'us.amazon.nova-2-lite-v1:0',
      ]);
      expect(adapter.getModelCatalog().models).toHaveLength(2);

      // Availability is queried with the underlying foundation model ID, never the profile ID.
      const availabilityCalls = mockControlClient.send.mock.calls
        .map(([cmd]) => (cmd as { input?: { modelId?: string } }).input?.modelId)
        .filter((id): id is string => Boolean(id));
      expect(availabilityCalls).toContain('moonshotai.kimi-k3');
      expect(availabilityCalls).toContain('amazon.nova-2-lite-v1:0');
      expect(availabilityCalls).not.toContain('us.moonshotai.kimi-k3');
      expect(availabilityCalls).not.toContain('us.amazon.nova-2-lite-v1:0');
    });

    it('omits an inference profile that is missing from ListInferenceProfiles', async () => {
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string } }) => {
          const modelId = cmd.input?.modelId;
          if (!modelId) {
            return {
              inferenceProfileSummaries: [
                { inferenceProfileId: 'us.moonshotai.kimi-k3', status: 'ACTIVE' },
              ],
            };
          }
          return {
            authorizationStatus: 'AUTHORIZED',
            entitlementAvailability: 'AVAILABLE',
            regionAvailability: 'AVAILABLE',
            agreementAvailability: { status: 'AVAILABLE' },
          };
        }),
      };

      const adapter = new AwsBedrockHarnessAdapter({
        controlClient: mockControlClient as unknown as BedrockClient,
        client: {} as unknown as BedrockRuntimeClient,
      });

      const available = await adapter.getAvailableModels();
      const ids = available.map((m) => m.id);
      expect(ids).toContain('us.moonshotai.kimi-k3');
      expect(ids).not.toContain('us.amazon.nova-2-lite-v1:0');
      expect(ids).not.toContain('us.amazon.nova-pro-v1:0');
    });

    it('caches verified availability for the documented TTL', async () => {
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string } }) => {
          if (!cmd.input?.modelId) {
            return {
              inferenceProfileSummaries: [
                { inferenceProfileId: 'us.moonshotai.kimi-k3', status: 'ACTIVE' },
              ],
            };
          }
          return {
            authorizationStatus: 'AUTHORIZED',
            entitlementAvailability: 'AVAILABLE',
            regionAvailability: 'AVAILABLE',
            agreementAvailability: { status: 'AVAILABLE' },
          };
        }),
      };

      const adapter = new AwsBedrockHarnessAdapter({
        controlClient: mockControlClient as unknown as BedrockClient,
        client: {} as unknown as BedrockRuntimeClient,
      });

      await adapter.getAvailableModels();
      const callCountAfterFirstCheck = mockControlClient.send.mock.calls.length;

      await adapter.getAvailableModels();
      expect(mockControlClient.send).toHaveBeenCalledTimes(callCountAfterFirstCheck);

      const realNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(realNow + MODEL_AVAILABILITY_TTL_MS + 1);
      try {
        await adapter.getAvailableModels();
        expect(mockControlClient.send.mock.calls.length).toBeGreaterThan(callCountAfterFirstCheck);
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('does not silently restore the hardcoded catalog when the availability API fails', async () => {
      const mockControlClient = {
        send: vi.fn().mockRejectedValue(new Error('AccessDeniedException: not authorized')),
      };

      const adapter = new AwsBedrockHarnessAdapter({
        controlClient: mockControlClient as unknown as BedrockClient,
        client: {} as unknown as BedrockRuntimeClient,
      });

      await expect(adapter.getAvailableModels()).rejects.toThrow('AccessDeniedException');
      expect(adapter.getModelCatalog().models).toHaveLength(18);
    });

    it('fails loudly when only a runtime client is injected and availability cannot be verified', async () => {
      const adapter = new AwsBedrockHarnessAdapter({
        client: { send: vi.fn() } as unknown as BedrockRuntimeClient,
      });

      await expect(adapter.getAvailableModels()).rejects.toThrow(
        'control-plane client is unavailable'
      );

      const aiService = new AiService({ adapters: [adapter] });
      const app = createApp({ logger: false, aiService });
      const res = await app.inject({ method: 'GET', url: '/api/ai/status' });
      const data = res.json<{ available: boolean; models?: unknown[]; message?: string }>();
      expect(data.available).toBe(false);
      expect(data.models).toBeUndefined();
      expect(data.message).toContain('control-plane client is unavailable');
    });

    it('surfaces the control-plane error when every availability check throws', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string } }) => {
          if (!cmd.input?.modelId) {
            return { inferenceProfileSummaries: [] };
          }
          throw new Error('ThrottlingException: too many requests');
        }),
      };

      const adapter = new AwsBedrockHarnessAdapter({
        controlClient: mockControlClient as unknown as BedrockClient,
        client: {} as unknown as BedrockRuntimeClient,
      });

      try {
        await expect(adapter.getAvailableModels()).rejects.toThrow('ThrottlingException');
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('reports AI unavailable with the availability error instead of advertising unverified models', async () => {
      const mockControlClient = {
        send: vi.fn().mockRejectedValue(new Error('AccessDeniedException: not authorized')),
      };

      const adapter = new AwsBedrockHarnessAdapter({
        controlClient: mockControlClient as unknown as BedrockClient,
        client: {} as unknown as BedrockRuntimeClient,
      });
      const aiService = new AiService({ adapters: [adapter] });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({ method: 'GET', url: '/api/ai/status' });
      expect(res.statusCode).toBe(200);
      const data = res.json<{ available: boolean; models?: unknown[]; message?: string }>();
      expect(data.available).toBe(false);
      expect(data.models).toBeUndefined();
      expect(data.message).toContain('AccessDeniedException');
    });

    it('reports AI unavailable when no catalog models are accessible for the account', async () => {
      const mockControlClient = {
        send: vi.fn().mockImplementation(async (cmd: { input?: { modelId?: string } }) => {
          if (!cmd.input?.modelId) {
            return { inferenceProfileSummaries: [] };
          }
          return {
            authorizationStatus: 'NOT_AUTHORIZED',
            entitlementAvailability: 'NOT_AVAILABLE',
            regionAvailability: 'AVAILABLE',
            agreementAvailability: { status: 'NOT_AVAILABLE' },
          };
        }),
      };

      const adapter = new AwsBedrockHarnessAdapter({
        controlClient: mockControlClient as unknown as BedrockClient,
        client: {} as unknown as BedrockRuntimeClient,
      });
      const aiService = new AiService({ adapters: [adapter] });
      const app = createApp({ logger: false, aiService });

      const res = await app.inject({ method: 'GET', url: '/api/ai/status' });
      expect(res.statusCode).toBe(200);
      const data = res.json<{ available: boolean; models?: unknown[]; message?: string }>();
      expect(data.available).toBe(false);
      expect(data.models).toBeUndefined();
      expect(data.message).toContain('No Amazon Bedrock models are accessible');
    });
  });

  describe('3. Client SSE Parser & UI Model Selector Tests', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it('chatWithScoutStream cleanly ignores : ping and : keep-alive frames and emits thought, delta, and done', async () => {
      const encoder = new TextEncoder();
      const mockStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(': ping\n\n'));
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
          controller.enqueue(
            encoder.encode('event: thought\ndata: {"text":"Reasoning about fuel stops..."}\n\n')
          );
          controller.enqueue(
            encoder.encode('event: delta\ndata: {"text":"Found Maverik at exit 285."}\n\n')
          );
          controller.enqueue(
            encoder.encode(
              'event: done\ndata: {"reply":"Found Maverik at exit 285.","suggestions":[],"sessionId":"s_test_123","engine":"bedrock","modelId":"us.moonshotai.kimi-k3"}\n\n'
            )
          );
          controller.close();
        },
      });

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'text/event-stream' }),
          body: mockStream,
        })
      );

      const emittedEvents: ScoutStreamEvent[] = [];
      const onEvent = vi.fn((evt: ScoutStreamEvent) => emittedEvents.push(evt));

      const request: ScoutChatRequest = {
        scope: { type: 'day', dayNumber: 1 },
        messages: [{ role: 'user', content: 'Find fuel' }],
        tripContext: sampleTripContext,
      };

      const response: ScoutChatResponse = await chatWithScoutStream(request, onEvent);

      expect(response).toEqual({
        reply: 'Found Maverik at exit 285.',
        suggestions: [],
        sessionId: 's_test_123',
        engine: 'bedrock',
        modelId: 'us.moonshotai.kimi-k3',
      });

      expect(onEvent).toHaveBeenCalledTimes(3);
      expect(emittedEvents[0]).toEqual({
        event: 'thought',
        data: { text: 'Reasoning about fuel stops...' },
      });
      expect(emittedEvents[1]).toEqual({
        event: 'delta',
        data: { text: 'Found Maverik at exit 285.' },
      });
      expect(emittedEvents[2]).toEqual({
        event: 'done',
        data: response,
      });
    });

    describe('UI Model Selectors', () => {
      const storageEntries = new Map<string, string>();
      const mounted: ReactTestRenderer[] = [];

      beforeEach(() => {
        storageEntries.clear();
        vi.stubGlobal('localStorage', {
          getItem: (key: string) => storageEntries.get(key) ?? null,
          setItem: (key: string, value: string) => storageEntries.set(key, value),
          removeItem: (key: string) => storageEntries.delete(key),
        });

        const documentStub = new EventTarget();
        Object.assign(documentStub, {
          body: { style: {} },
        });
        vi.stubGlobal('document', documentStub);

        const windowStub = new EventTarget();
        Object.assign(windowStub, {
          location: { href: 'http://localhost:5173' },
          speechSynthesis: {
            cancel: vi.fn(),
            speak: vi.fn(),
          },
        });
        vi.stubGlobal('window', windowStub);
      });

      afterEach(() => {
        for (const inst of mounted) {
          act(() => {
            inst.unmount();
          });
        }
        mounted.length = 0;
      });

      it('renders <RouteScoutDrawer> with Route Scout AI Model selector containing only scout / both models and triggers onChange', () => {
        const onSelectScoutModel = vi.fn();
        let app!: ReactTestRenderer;

        act(() => {
          app = create(
            <RouteScoutDrawer
              isOpen={true}
              onClose={vi.fn()}
              trip={sampleTrip}
              activeDayIndex={0}
              activeDay={sampleTrip.days[0]}
              waypoints={[]}
              scope={{ type: 'day', dayNumber: 1 }}
              onChangeScope={vi.fn()}
              onAddWaypoint={vi.fn()}
              onUpdateWaypoint={vi.fn()}
              onPreviewCoordinate={vi.fn()}
              aiModels={BEDROCK_MODEL_CATALOG}
              selectedModelId="us.moonshotai.kimi-k3"
              onSelectModel={onSelectScoutModel}
            />
          );
        });
        mounted.push(app);

        // Find the select element by aria-label
        const select = app.root.findByProps({ 'aria-label': 'Route Scout AI Model' });
        expect(select).toBeDefined();
        expect(select.props.value).toBe('us.moonshotai.kimi-k3');

        // Verify options contain only scout or both models
        const options = select.findAllByType('option');
        expect(options.length).toBeGreaterThan(0);

        for (const opt of options) {
          const optModelId = opt.props.value;
          const matchingCatalogModel = BEDROCK_MODEL_CATALOG.find((m) => m.id === optModelId);
          expect(matchingCatalogModel).toBeDefined();
          expect(['scout', 'both']).toContain(matchingCatalogModel?.role);
        }

        // Trigger change to another model
        act(() => {
          select.props.onChange({ target: { value: 'us.amazon.nova-pro-v1:0' } });
        });

        expect(onSelectScoutModel).toHaveBeenCalledTimes(1);
        expect(onSelectScoutModel).toHaveBeenCalledWith('us.amazon.nova-pro-v1:0');
      });

      it('renders <EditWaypointModal> with Copywriter AI Model selector excluding scout-only models and triggers onChange', () => {
        const onSelectCopywriterModel = vi.fn();
        let app!: ReactTestRenderer;

        act(() => {
          app = create(
            <EditWaypointModal
              isOpen={true}
              initialTab="alert"
              waypoint={sampleWaypointWithDetails}
              onClose={vi.fn()}
              onSave={vi.fn()}
              aiModels={BEDROCK_MODEL_CATALOG}
              selectedModelId="us.amazon.nova-2-lite-v1:0"
              onSelectModel={onSelectCopywriterModel}
            />
          );
        });
        mounted.push(app);

        // Find the select element by aria-label
        const select = app.root.findByProps({ 'aria-label': 'Copywriter AI Model' });
        expect(select).toBeDefined();
        expect(select.props.value).toBe('us.amazon.nova-2-lite-v1:0');

        // Verify options contain only copywriter or both models (excluding scout-only)
        const options = select.findAllByType('option');
        expect(options.length).toBeGreaterThan(0);

        const renderedModelIds = options.map((opt) => opt.props.value);

        // Scout-only models must NOT be present in copywriter select
        expect(renderedModelIds).not.toContain('us.openai.gpt-6-astra');
        expect(renderedModelIds).not.toContain('us.anthropic.claude-opus-5-5');

        for (const opt of options) {
          const optModelId = opt.props.value;
          const matchingCatalogModel = BEDROCK_MODEL_CATALOG.find((m) => m.id === optModelId);
          expect(matchingCatalogModel).toBeDefined();
          expect(['copywriter', 'both']).toContain(matchingCatalogModel?.role);
        }

        // Trigger change
        act(() => {
          select.props.onChange({ target: { value: 'us.amazon.nova-pro-v1:0' } });
        });

        expect(onSelectCopywriterModel).toHaveBeenCalledTimes(1);
        expect(onSelectCopywriterModel).toHaveBeenCalledWith('us.amazon.nova-pro-v1:0');
      });
    });
  });
});
