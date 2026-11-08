import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AwsBedrockHarnessAdapter,
  InvalidModelError,
  DEFAULT_BEDROCK_SCOUT_MODEL_ID,
  DEFAULT_BEDROCK_COPYWRITER_MODEL_ID,
  MAX_TOOL_ITERATIONS,
  MODEL_AVAILABILITY_TTL_MS,
  sanitizeBedrockResponse,
  formatBedrockToolLabel,
  toFoundationModelId,
} from './bedrockService.js';
import type { BedrockClient } from '@aws-sdk/client-bedrock';
import {
  AiService,
  type AiHarnessAdapter,
} from './aiService.js';
import { ScoutService } from './scoutService.js';
import { MalformedAiResponseError } from './schemaParser.js';
import { SCOUT_TOOL_DECLARATIONS } from './scoutTools.js';
import {
  ConverseCommand,
  ConverseStreamCommand,
  type BedrockRuntimeClient,
  type ConverseStreamOutput,
} from '@aws-sdk/client-bedrock-runtime';
import {
  TEST_MOCK_MODELS,
  sampleWaypoint,
  sampleTripContext,
  sampleTools,
  createAsyncStream,
} from '../test-helpers/bedrockFixtures.js';

describe('Bedrock generate and stream', () => {
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
        const adapter = new AwsBedrockHarnessAdapter({
          client: mockClient,
          availableModels: TEST_MOCK_MODELS,
        });

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
          availableModels: TEST_MOCK_MODELS,
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
          availableModels: TEST_MOCK_MODELS,
        });

        await expect(adapter.generate('Prompt')).rejects.toThrow(
          'AI provider returned an empty response'
        );
      });

      it('throws MalformedAiResponseError when stopReason is max_tokens', async () => {
        const mockSend = vi.fn().mockResolvedValue({
          stopReason: 'max_tokens',
          output: {
            message: {
              content: [{ text: 'Truncated alert copy...' }],
            },
          },
        });

        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
          availableModels: TEST_MOCK_MODELS,
        });

        await expect(adapter.generate('Prompt')).rejects.toThrow(MalformedAiResponseError);
        await expect(adapter.generate('Prompt')).rejects.toThrow(/max_tokens/);
      });

      it('throws MalformedAiResponseError when stopReason is content_filtered', async () => {
        const mockSend = vi.fn().mockResolvedValue({
          stopReason: 'content_filtered',
          output: {
            message: {
              content: [{ text: 'Blocked content...' }],
            },
          },
        });

        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
          availableModels: TEST_MOCK_MODELS,
        });

        await expect(adapter.generate('Prompt')).rejects.toThrow(MalformedAiResponseError);
        await expect(adapter.generate('Prompt')).rejects.toThrow(/content_filtered/);
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
          availableModels: TEST_MOCK_MODELS,
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
          availableModels: TEST_MOCK_MODELS,
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
          availableModels: TEST_MOCK_MODELS,
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
          availableModels: TEST_MOCK_MODELS,
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
          availableModels: TEST_MOCK_MODELS,
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

      it('throws MalformedAiResponseError when messageStop.stopReason is max_tokens', async () => {
        const streamChunks: ConverseStreamOutput[] = [
          { contentBlockDelta: { delta: { text: 'Starting route analysis...' } } },
          { messageStop: { stopReason: 'max_tokens' } },
        ];
        const mockSend = vi.fn().mockImplementation(() => ({
          stream: createAsyncStream(streamChunks),
        }));
        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
          availableModels: TEST_MOCK_MODELS,
        });

        await expect(
          adapter.generateStreamWithTools('Prompt', [], vi.fn(), vi.fn())
        ).rejects.toThrow(MalformedAiResponseError);
        await expect(
          adapter.generateStreamWithTools('Prompt', [], vi.fn(), vi.fn())
        ).rejects.toThrow(/max_tokens/);
      });

      it('throws MalformedAiResponseError when messageStop.stopReason is content_filtered', async () => {
        const streamChunks: ConverseStreamOutput[] = [
          { contentBlockDelta: { delta: { text: 'Inappropriate content...' } } },
          { messageStop: { stopReason: 'content_filtered' } },
        ];
        const mockSend = vi.fn().mockImplementation(() => ({
          stream: createAsyncStream(streamChunks),
        }));
        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
          availableModels: TEST_MOCK_MODELS,
        });

        await expect(
          adapter.generateStreamWithTools('Prompt', [], vi.fn(), vi.fn())
        ).rejects.toThrow(MalformedAiResponseError);
        await expect(
          adapter.generateStreamWithTools('Prompt', [], vi.fn(), vi.fn())
        ).rejects.toThrow(/content_filtered/);
      });

      it('throws MalformedAiResponseError when stream ends without a terminal messageStop', async () => {
        const streamChunks: ConverseStreamOutput[] = [
          { contentBlockDelta: { delta: { text: 'Incomplete stream truncated abruptly' } } },
        ];
        const mockSend = vi.fn().mockImplementation(() => ({
          stream: createAsyncStream(streamChunks),
        }));
        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
          availableModels: TEST_MOCK_MODELS,
        });

        await expect(
          adapter.generateStreamWithTools('Prompt', [], vi.fn(), vi.fn())
        ).rejects.toThrow(MalformedAiResponseError);
        await expect(
          adapter.generateStreamWithTools('Prompt', [], vi.fn(), vi.fn())
        ).rejects.toThrow(/without a terminal message/);
      });

      it('throws MalformedAiResponseError when stopReason is tool_use but no tool calls were emitted', async () => {
        const streamChunks: ConverseStreamOutput[] = [
          { contentBlockDelta: { delta: { text: 'I will call a tool now.' } } },
          { messageStop: { stopReason: 'tool_use' } },
        ];
        const mockSend = vi.fn().mockImplementation(() => ({
          stream: createAsyncStream(streamChunks),
        }));
        const adapter = new AwsBedrockHarnessAdapter({
          client: { send: mockSend } as unknown as BedrockRuntimeClient,
          availableModels: TEST_MOCK_MODELS,
        });

        await expect(
          adapter.generateStreamWithTools('Prompt', [], vi.fn(), vi.fn())
        ).rejects.toThrow(MalformedAiResponseError);
        await expect(
          adapter.generateStreamWithTools('Prompt', [], vi.fn(), vi.fn())
        ).rejects.toThrow(/emitted no executable tool calls/);
      });
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
    it('AwsBedrockHarnessAdapter redacts ARNs/SSM parameter names from tool errors and rejects malformed tool input JSON', async () => {
      let callCount = 0;
      const mockBedrockSend = vi.fn().mockImplementation(async (cmd: { input?: { messages?: unknown[] } }) => {
        callCount++;
        if (callCount === 1) {
          return {
            stream: (async function* () {
              yield {
                contentBlockStart: {
                  contentBlockIndex: 0,
                  start: { toolUse: { toolUseId: 'tu_bad_json', name: 'search_web' } },
                },
              };
              yield {
                contentBlockDelta: {
                  contentBlockIndex: 0,
                  delta: { toolUse: { input: '{malformed_json' } },
                },
              };
              yield {
                contentBlockStart: {
                  contentBlockIndex: 1,
                  start: { toolUse: { toolUseId: 'tu_arn_err', name: 'search_web' } },
                },
              };
              yield {
                contentBlockDelta: {
                  contentBlockIndex: 1,
                  delta: { toolUse: { input: '{"query":"sedona"}' } },
                },
              };
              yield { messageStop: { stopReason: 'tool_use' } };
            })(),
          };
        }
        return {
          stream: (async function* () {
            yield {
              contentBlockDelta: {
                contentBlockIndex: 0,
                delta: { text: 'Completed after handling tool errors.' },
              },
            };
            yield { messageStop: { stopReason: 'end_turn' } };
          })(),
        };
      });

      const adapter = new AwsBedrockHarnessAdapter({
        client: { send: mockBedrockSend } as unknown as ConstructorParameters<typeof AwsBedrockHarnessAdapter>[0]['client'],
        availableModels: [{ id: 'us.moonshotai.kimi-k3', name: 'Kimi K3', role: 'both', provider: 'Moonshot AI' }],
      });

      const dispatcher = vi.fn().mockRejectedValue(
        new Error(
          'AccessDeniedException: User arn:aws:sts::123456789012:assumed-role/FastifyRole/session is not authorized to read /roadtrip-copilot/brave-search-api-key'
        )
      );

      const res = await adapter.generateStreamWithTools(
        'Test prompt',
        SCOUT_TOOL_DECLARATIONS,
        dispatcher,
        () => {}
      );

      expect(res.text).toBe('Completed after handling tool errors.');
      // Dispatcher was ONLY called once (for tu_arn_err, NOT for tu_bad_json)
      expect(dispatcher).toHaveBeenCalledTimes(1);

      // Inspect the second ConverseStreamCommand's toolResult blocks
      const secondCallInput = mockBedrockSend.mock.calls[1][0].input;
      const toolTurnMsg = secondCallInput.messages[2];
      const toolResultsJson = JSON.stringify(toolTurnMsg.content);
      expect(toolResultsJson).toContain('was malformed JSON');
      expect(toolResultsJson).toContain('[redacted-arn]');
      expect(toolResultsJson).toContain('[redacted-ssm-parameter]');
      expect(toolResultsJson).not.toContain('123456789012');
      expect(toolResultsJson).not.toContain('/roadtrip-copilot/brave-search-api-key');
    });

});
