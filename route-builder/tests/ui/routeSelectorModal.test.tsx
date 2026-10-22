import React from 'react';
import * as renderer from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { X } from 'lucide-react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RouteSelectorModal } from '../../src/components/RouteSelectorModal';
import {
  fetchItineraryList,
  fetchItinerary,
  deleteItinerary,
} from '../../src/services/api';
import type { ParsedTrip } from '../../src/engine/itineraryParser';

vi.mock('../../src/services/api', () => ({
  fetchItineraryList: vi.fn(),
  fetchItinerary: vi.fn(),
  deleteItinerary: vi.fn(),
}));

const act = renderer.act;
const create = renderer.create;

type KeydownListener = (event: { key: string }) => void;

const addEventListenerMock = vi.fn<(type: string, listener: KeydownListener) => void>();
const removeEventListenerMock = vi.fn<(type: string, listener: KeydownListener) => void>();

/** Flattens the rendered text of a node, including text nested inside child elements. */
const buttonText = (node: ReactTestInstance): string => {
  const collect = (child: string | ReactTestInstance): string =>
    typeof child === 'string' ? child : child.children.map(collect).join('');
  return node.children.map(collect).join('');
};

/** Returns the most recently registered window keydown listener from the test stub. */
const findLastKeydownListener = (): KeydownListener | undefined => {
  const calls = addEventListenerMock.mock.calls.filter(([type]) => type === 'keydown');
  return calls.length > 0 ? calls[calls.length - 1][1] : undefined;
};

const findButton = (root: ReactTestRenderer, label: string): ReactTestInstance | undefined =>
  root.root.findAllByType('button').find((b) => buttonText(b).includes(label));

const sampleWorkspaceSummary = {
  fileName: 'workspace_trip.json',
  tripName: 'Workspace Trip',
  isMultiDay: false,
  dayCount: 1,
  totalCheckpoints: 2,
  days: [
    {
      dayNumber: 1,
      date: '2026-10-10',
      checkpointCount: 2,
    },
  ],
};

const sampleWorkspaceRaw = {
  trip_name: 'Workspace Trip',
  date: '2026-10-10',
  timezone: 'America/Phoenix',
  checkpoints: [
    { id: 'w1', name: 'Start', type: 'origin', lat: 34.0, lng: -111.0, target_time: '09:00:00' },
    { id: 'w2', name: 'End', type: 'destination', lat: 34.5, lng: -111.5, target_time: '11:00:00' },
  ],
};

describe('RouteSelectorModal regression tests', () => {
  const mounted: ReactTestRenderer[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.stubGlobal('window', {
      addEventListener: addEventListenerMock,
      removeEventListener: removeEventListenerMock,
    });
    vi.mocked(fetchItineraryList).mockResolvedValue({
      itineraries: [sampleWorkspaceSummary],
    });
    vi.mocked(fetchItinerary).mockResolvedValue(sampleWorkspaceRaw);
    vi.mocked(deleteItinerary).mockResolvedValue({ success: true, fileName: 'workspace_trip.json' });
  });

  afterEach(async () => {
    for (const inst of mounted) {
      await act(async () => {
        inst.unmount();
      });
    }
    mounted.length = 0;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('Bug D (1): late workspace route fetch does not call onSelectTrip after modal is closed', async () => {
    let resolveItinerary!: (val: unknown) => void;
    vi.mocked(fetchItinerary).mockReturnValue(
      new Promise((resolve) => {
        resolveItinerary = resolve;
      })
    );

    const onSelectTrip = vi.fn();
    const onClose = vi.fn();

    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(
        <RouteSelectorModal
          isOpen={true}
          onClose={onClose}
          onSelectTrip={onSelectTrip}
          currentFileName="current.json"
        />
      );
    });
    mounted.push(root);

    // Wait for list to load
    await act(async () => {
      await Promise.resolve();
    });

    // Find and click the workspace route button
    const buttons = root.root.findAllByType('button');
    const loadButton = buttons.find((b) => {
      const text = b.children.map((c) => (typeof c === 'string' ? c : '')).join('');
      return text.includes('Workspace Trip') || b.props.onClick?.toString().includes('handleSelectWorkspaceRoute');
    });

    expect(loadButton).toBeDefined();

    // Trigger loading of the workspace route (which is now deferred)
    await act(async () => {
      loadButton!.props.onClick();
    });

    // Close the modal while fetch is pending
    await act(async () => {
      root.update(
        <RouteSelectorModal
          isOpen={false}
          onClose={onClose}
          onSelectTrip={onSelectTrip}
          currentFileName="current.json"
        />
      );
    });

    // Now the slow fetch completes
    await act(async () => {
      resolveItinerary(sampleWorkspaceRaw);
      await Promise.resolve();
    });

    // onSelectTrip MUST NOT have been called because the modal was closed
    expect(onSelectTrip).not.toHaveBeenCalled();
  });

  it('Bug D (1): parent re-render with a new onClose identity does not cancel a pending selection while open', async () => {
    let resolveItinerary!: (val: unknown) => void;
    vi.mocked(fetchItinerary).mockReturnValue(
      new Promise((resolve) => {
        resolveItinerary = resolve;
      })
    );

    const onSelectTrip = vi.fn();
    const renderModal = () => (
      <RouteSelectorModal
        isOpen={true}
        onClose={() => {}}
        onSelectTrip={onSelectTrip}
        currentFileName="current.json"
      />
    );

    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(renderModal());
    });
    mounted.push(root);
    await act(async () => {
      await Promise.resolve();
    });

    const loadButton = root.root.findAllByType('button').find((b) => {
      const text = b.children.map((c) => (typeof c === 'string' ? c : '')).join('');
      return text.includes('Workspace Trip') || b.props.onClick?.toString().includes('handleSelectWorkspaceRoute');
    });
    expect(loadButton).toBeDefined();

    await act(async () => {
      loadButton!.props.onClick();
    });

    // Parent re-renders (fresh inline onClose) while the modal stays open
    await act(async () => {
      root.update(renderModal());
    });

    await act(async () => {
      resolveItinerary(sampleWorkspaceRaw);
      await Promise.resolve();
    });

    expect(onSelectTrip).toHaveBeenCalledTimes(1);
  });

  it('Bug A: passes { unsaved: true } when creating a new blank trip', async () => {
    const onSelectTrip = vi.fn();
    const onClose = vi.fn();

    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(
        <RouteSelectorModal
          isOpen={true}
          onClose={onClose}
          onSelectTrip={onSelectTrip}
          currentFileName="current.json"
        />
      );
    });
    mounted.push(root);

    // Switch to "new" tab
    const tabButtons = root.root.findAllByType('button');
    const newTab = tabButtons.find((b) => {
      const text = b.children.map((c) => (typeof c === 'string' ? c : (c as { children?: string[] }).children?.join('') || '')).join('');
      return text.includes('New Route');
    });
    expect(newTab).toBeDefined();

    await act(async () => {
      newTab!.props.onClick();
    });

    // Click "Create Blank Itinerary" button
    const buttons = root.root.findAllByType('button');
    const createBtn = buttons.find((b) => {
      const text = b.children.map((c) => (typeof c === 'string' ? c : (c as { children?: string[] }).children?.join('') || '')).join('');
      return text.includes('Create Blank Itinerary');
    });
    expect(createBtn).toBeDefined();

    await act(async () => {
      createBtn!.props.onClick();
    });

    expect(onSelectTrip).toHaveBeenCalledTimes(1);
    expect(onSelectTrip).toHaveBeenCalledWith(
      expect.objectContaining({ tripName: 'My Road Trip' }),
      { unsaved: true }
    );
  });

  it('Bug A: passes { unsaved: true } when confirming an imported itinerary', async () => {
    const onSelectTrip = vi.fn();
    const onClose = vi.fn();

    class FakeFileReader {
      onload: ((event: { target: { result: string } }) => void) | null = null;
      readAsText() {
        this.onload?.({ target: { result: JSON.stringify(sampleWorkspaceRaw) } });
      }
    }
    vi.stubGlobal('FileReader', FakeFileReader);

    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(
        <RouteSelectorModal
          isOpen={true}
          onClose={onClose}
          onSelectTrip={onSelectTrip}
          currentFileName="current.json"
        />
      );
    });
    mounted.push(root);

    // Switch to "import" tab
    const tabButtons = root.root.findAllByType('button');
    const importTab = tabButtons.find((b) => {
      const text = b.children.map((c) => (typeof c === 'string' ? c : (c as { children?: string[] }).children?.join('') || '')).join('');
      return text.includes('Import JSON File');
    });
    expect(importTab).toBeDefined();

    await act(async () => {
      importTab!.props.onClick();
    });

    // Trigger file change on input
    const fileInput = root.root.findByType('input');
    await act(async () => {
      fileInput.props.onChange({
        target: {
          files: [{ name: 'imported_trip.json' }],
        },
      });
    });

    // Find and click "Load This File"
    const buttons = root.root.findAllByType('button');
    const loadBtn = buttons.find((b) => {
      const text = b.children.map((c) => (typeof c === 'string' ? c : (c as { children?: string[] }).children?.join('') || '')).join('');
      return text.includes('Load This File');
    });
    expect(loadBtn).toBeDefined();

    await act(async () => {
      loadBtn!.props.onClick();
    });

    expect(onSelectTrip).toHaveBeenCalledTimes(1);
    expect(onSelectTrip).toHaveBeenCalledWith(
      expect.objectContaining({ tripName: 'Workspace Trip' }),
      { unsaved: true }
    );
  });

  it('Defect 1: cancelling workspace load by closing modal clears loading indicator on reopen', async () => {
    let resolveItinerary!: (val: unknown) => void;
    vi.mocked(fetchItinerary).mockReturnValue(
      new Promise((resolve) => {
        resolveItinerary = resolve;
      })
    );

    const onSelectTrip = vi.fn();
    const onClose = vi.fn();

    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(
        <RouteSelectorModal
          isOpen={true}
          onClose={onClose}
          onSelectTrip={onSelectTrip}
          currentFileName="current.json"
        />
      );
    });
    mounted.push(root);

    await act(async () => {
      await Promise.resolve();
    });

    const buttons = root.root.findAllByType('button');
    const loadButton = buttons.find((b) =>
      b.props.onClick?.toString().includes('handleSelectWorkspaceRoute')
    );
    expect(loadButton).toBeDefined();

    // Trigger load of route (deferred)
    await act(async () => {
      loadButton!.props.onClick();
    });

    // Close modal while fetch is pending
    await act(async () => {
      root.update(
        <RouteSelectorModal
          isOpen={false}
          onClose={onClose}
          onSelectTrip={onSelectTrip}
          currentFileName="current.json"
        />
      );
    });

    // The slow fetch completes while modal is closed
    await act(async () => {
      resolveItinerary(sampleWorkspaceRaw);
      await Promise.resolve();
    });

    // Reopen modal
    await act(async () => {
      root.update(
        <RouteSelectorModal
          isOpen={true}
          onClose={onClose}
          onSelectTrip={onSelectTrip}
          currentFileName="current.json"
        />
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    // Find the button for workspace route again
    const reopenedButtons = root.root.findAllByType('button');
    const reopenedLoadBtn = reopenedButtons.find((b) =>
      b.props.onClick?.toString().includes('handleSelectWorkspaceRoute')
    );

    expect(reopenedLoadBtn).toBeDefined();
    expect(reopenedLoadBtn!.props.disabled).toBe(false);
  });

  it('Defect 2: captures generation before DELETE request resolves and passes it to onDeleteTrip', async () => {
    let resolveDelete!: (val: { success: boolean; fileName: string }) => void;
    vi.mocked(deleteItinerary).mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = resolve;
      })
    );

    const onSelectTrip = vi.fn();
    const onClose = vi.fn();
    const onDeleteTrip = vi.fn();
    let currentGen = 42;
    const getTripGeneration = vi.fn(() => currentGen);

    const ModalComponent = RouteSelectorModal as React.ComponentType<{
      isOpen: boolean;
      onClose: () => void;
      onSelectTrip: (trip: unknown) => void;
      onDeleteTrip?: (fileName: string, startedGeneration?: number) => void;
      getTripGeneration?: () => number;
      currentFileName?: string;
    }>;

    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(
        <ModalComponent
          isOpen={true}
          onClose={onClose}
          onSelectTrip={onSelectTrip}
          onDeleteTrip={onDeleteTrip}
          getTripGeneration={getTripGeneration}
          currentFileName="current.json"
        />
      );
    });
    mounted.push(root);

    await act(async () => {
      await Promise.resolve();
    });

    // Click trash button to show confirm
    const buttons = root.root.findAllByType('button');
    const deleteBtn = buttons.find((b) => b.props.title?.includes('Delete Workspace Trip'));
    expect(deleteBtn).toBeDefined();

    await act(async () => {
      deleteBtn!.props.onClick();
    });

    // Click confirm delete button ("Delete?")
    const confirmButtons = root.root.findAllByType('button');
    const confirmBtn = confirmButtons.find((b) =>
      b.props.title === 'Confirm permanently deleting this itinerary'
    );
    expect(confirmBtn).toBeDefined();

    await act(async () => {
      confirmBtn!.props.onClick();
    });

    // Generation is bumped while delete is in-flight
    currentGen = 43;

    // Resolve delete
    await act(async () => {
      resolveDelete({ success: true, fileName: 'workspace_trip.json' });
      await Promise.resolve();
    });

    // onDeleteTrip should have received generation 42 (captured when delete was initiated)
    expect(onDeleteTrip).toHaveBeenCalledWith('workspace_trip.json', 42);
  });

  it('New tab: Start from Sample Route selects a fresh sample trip', async () => {
    const onSelectTrip = vi.fn();
    const onClose = vi.fn();

    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(
        <RouteSelectorModal
          isOpen={true}
          onClose={onClose}
          onSelectTrip={onSelectTrip}
          currentFileName="current.json"
        />
      );
    });
    mounted.push(root);

    const newTab = findButton(root, 'New Route');
    expect(newTab).toBeDefined();

    await act(async () => {
      newTab!.props.onClick();
    });

    // The blank-itinerary form and the sample action both render on this tab
    expect(findButton(root, 'Create Blank Itinerary')).toBeDefined();
    const sampleBtn = findButton(root, 'Start from Sample Route');
    expect(sampleBtn).toBeDefined();

    await act(async () => {
      sampleBtn!.props.onClick();
    });

    expect(onSelectTrip).toHaveBeenCalledTimes(1);
    expect(onSelectTrip).toHaveBeenCalledWith(
      expect.objectContaining({
        tripName: 'Scenic Southwest: Phoenix to Flagstaff',
        isAdHoc: true,
        isMultiDay: false,
      }),
      { unsaved: true }
    );

    const [selectedTrip] = vi.mocked(onSelectTrip).mock.calls[0];
    const parsedTrip = selectedTrip as ParsedTrip;
    expect(parsedTrip.days[0].waypoints).toHaveLength(4);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Workspace empty state: offers both sample and blank starts', async () => {
    vi.mocked(fetchItineraryList).mockResolvedValue({ itineraries: [] });
    const onSelectTrip = vi.fn();
    const onClose = vi.fn();

    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(
        <RouteSelectorModal
          isOpen={true}
          onClose={onClose}
          onSelectTrip={onSelectTrip}
          currentFileName="current.json"
        />
      );
    });
    mounted.push(root);

    await act(async () => {
      await Promise.resolve();
    });

    expect(findButton(root, 'Start from Sample Route')).toBeDefined();
    expect(findButton(root, 'Start Blank')).toBeDefined();

    await act(async () => {
      findButton(root, 'Start from Sample Route')!.props.onClick();
    });

    expect(onSelectTrip).toHaveBeenCalledWith(
      expect.objectContaining({
        tripName: 'Scenic Southwest: Phoenix to Flagstaff',
        isAdHoc: true,
        isMultiDay: false,
      }),
      { unsaved: true }
    );
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      findButton(root, 'Start Blank')!.props.onClick();
    });

    expect(JSON.stringify(root.toJSON())).toContain('Trip / Route Name');
    expect(findButton(root, 'Create Blank Itinerary')).toBeDefined();
  });

  it('dismissible={false} hides the X button and blocks Escape and backdrop dismissal', async () => {
    const onClose = vi.fn();

    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(
        <RouteSelectorModal
          isOpen={true}
          onClose={onClose}
          onSelectTrip={vi.fn()}
          currentFileName="current.json"
          dismissible={false}
        />
      );
    });
    mounted.push(root);

    await act(async () => {
      await Promise.resolve();
    });

    expect(root.root.findAllByType(X)).toHaveLength(0);

    const keydown = findLastKeydownListener();
    expect(keydown).toBeDefined();
    act(() => {
      keydown!({ key: 'Escape' });
    });
    expect(onClose).not.toHaveBeenCalled();

    const backdrop = root.root.findAll(
      (node) =>
        typeof node.props.className === 'string' &&
        node.props.className.includes('fixed inset-0 z-[1200]')
    )[0];
    expect(backdrop).toBeDefined();

    act(() => {
      const backdropNode = {};
      backdrop.props.onClick({ target: backdropNode, currentTarget: backdropNode });
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('dismissible mode still closes via X, Escape, and backdrop click', async () => {
    const onClose = vi.fn();

    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(
        <RouteSelectorModal
          isOpen={true}
          onClose={onClose}
          onSelectTrip={vi.fn()}
          currentFileName="current.json"
        />
      );
    });
    mounted.push(root);

    await act(async () => {
      await Promise.resolve();
    });

    expect(root.root.findAllByType(X)).toHaveLength(1);

    const keydown = findLastKeydownListener();
    expect(keydown).toBeDefined();
    act(() => {
      keydown!({ key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    const backdrop = root.root.findAll(
      (node) =>
        typeof node.props.className === 'string' &&
        node.props.className.includes('fixed inset-0 z-[1200]')
    )[0];
    expect(backdrop).toBeDefined();
    act(() => {
      const backdropNode = {};
      backdrop.props.onClick({ target: backdropNode, currentTarget: backdropNode });
    });
    expect(onClose).toHaveBeenCalledTimes(2);

    const closeBtn = root.root
      .findAllByType('button')
      .find((b) => b.props.onClick === onClose);
    expect(closeBtn).toBeDefined();
    act(() => {
      closeBtn!.props.onClick();
    });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('list failure shows an error with Retry that re-fetches and renders the routes', async () => {
    vi.mocked(fetchItineraryList)
      .mockRejectedValueOnce(new Error('Workspace unavailable'))
      .mockResolvedValueOnce({ itineraries: [sampleWorkspaceSummary] });

    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(
        <RouteSelectorModal
          isOpen={true}
          onClose={vi.fn()}
          onSelectTrip={vi.fn()}
          currentFileName="current.json"
        />
      );
    });
    mounted.push(root);

    await act(async () => {
      await Promise.resolve();
    });

    expect(JSON.stringify(root.toJSON())).toContain('Workspace unavailable');
    const retryBtn = findButton(root, 'Retry');
    expect(retryBtn).toBeDefined();
    expect(fetchItineraryList).toHaveBeenCalledTimes(1);

    await act(async () => {
      retryBtn!.props.onClick();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchItineraryList).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(root.toJSON())).toContain('Workspace Trip');
    expect(JSON.stringify(root.toJSON())).not.toContain('Workspace unavailable');
  });
});
