import React from 'react';
import * as renderer from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditWaypointModal } from './EditWaypointModal.js';
import type { Waypoint } from '../types/routing.js';
import type { AiModelOption } from '../types/ai.js';

vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return {
    ...actual,
    createPortal: (children: React.ReactNode) => children,
  };
});

const act = renderer.act;
const create = renderer.create;
const mounted: ReactTestRenderer[] = [];

beforeEach(() => {
  const documentStub = new EventTarget();
  Object.assign(documentStub, { body: { style: {} } });
  vi.stubGlobal('document', documentStub);
  const windowStub = new EventTarget();
  Object.assign(windowStub, {
    location: { href: 'http://localhost:5173' },
    speechSynthesis: { cancel: vi.fn(), speak: vi.fn() },
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
  vi.unstubAllGlobals();
});

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

const TEST_MOCK_MODELS: AiModelOption[] = [
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

describe('EditWaypointModal copywriter model selector', () => {
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
              aiModels={TEST_MOCK_MODELS}
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
          const matchingCatalogModel = TEST_MOCK_MODELS.find((m) => m.id === optModelId);
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

      it('gates Waypoint edit modal generate alert button when selectedModelId is empty (R5)', () => {
        let modal!: ReactTestRenderer;
        act(() => {
          modal = create(
            <EditWaypointModal
              isOpen={true}
              initialTab="alert"
              onClose={vi.fn()}
              onSave={vi.fn()}
              waypoint={sampleWaypointWithDetails}
              aiModels={TEST_MOCK_MODELS}
              selectedModelId=""
            />
          );
        });
        mounted.push(modal);

        const generateBtn = modal.root.findByProps({ title: 'Select an AI model to generate alert' });
        expect(generateBtn.props.disabled).toBe(true);
      });
});
