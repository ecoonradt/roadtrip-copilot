import React from 'react';
import * as renderer from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditWaypointModal } from './EditWaypointModal';
import type { Waypoint } from '../types/routing';
import type { AiModelOption } from '../types/ai';
import { TEST_MOCK_MODELS, setupBrowserTestGlobals } from '../test-helpers/aiFixtures';

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
  setupBrowserTestGlobals();
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
