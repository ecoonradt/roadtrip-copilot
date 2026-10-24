import { AiService } from './aiService.js';
import { AwsBedrockHarnessAdapter } from './bedrockService.js';

/**
 * Composition root for AI provider adapters.
 *
 * `AiService` itself is provider-agnostic; this module is the only place that
 * binds a concrete provider. Swapping providers means registering a different
 * `AiHarnessAdapter` here (or injecting one through `AiServiceOptions`), with no
 * changes to the generation, parsing, or Route Scout layers.
 */
export function createDefaultAiService(): AiService {
  return new AiService({
    adapters: [new AwsBedrockHarnessAdapter()],
    primaryAdapterId: 'bedrock',
  });
}

export const defaultAiService = createDefaultAiService();
