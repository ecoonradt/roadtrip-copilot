import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountMenu } from '../../src/components/AccountMenu';
import { AppHeader } from '../../src/components/AppHeader';
import type { AuthUser } from '../../src/types/auth';
import type { GoogleMapsRouteResult } from '../../src/engine/types';

const user: AuthUser = {
  sub: 'google-user',
  name: 'Alex Morgan Rivera',
  email: 'alex.rivera@example.com',
};
const mounted: ReactTestRenderer[] = [];

function mount(element: React.ReactElement, options?: Parameters<typeof create>[1]) {
  let app!: ReactTestRenderer;
  act(() => { app = create(element, options); });
  mounted.push(app);
  return app;
}

function button(app: ReactTestRenderer, label: string) {
  return app.root.find((node) => node.type === 'button' && node.props['aria-label'] === label);
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
}

function mapsRoute(count: number): GoogleMapsRouteResult {
  return {
    totalLegs: count,
    primaryUrl: 'https://maps.example/0',
    legs: Array.from({ length: count }, (_, index) => ({
      legIndex: index,
      legNumber: index + 1,
      title: `Leg ${index + 1}`,
      origin: { lat: 33, lng: -112 },
      destination: { lat: 34, lng: -111 },
      intermediateWaypoints: [],
      waypointCount: 2,
      url: `https://maps.example/${index}`,
    })),
  };
}

function headerProps(overrides: Partial<React.ComponentProps<typeof AppHeader>> = {}): React.ComponentProps<typeof AppHeader> {
  return {
    route: null,
    isLoadingRoute: false,
    routeError: null,
    baseDate: '2026-10-20',
    setBaseDate: vi.fn(),
    departureTime: '09:00:00',
    setDepartureTime: vi.fn(),
    schedulingMode: 'forward',
    setSchedulingMode: vi.fn(),
    targetArrivalTime: '17:00:00',
    setTargetArrivalTime: vi.fn(),
    backwardInfo: null,
    cascadeResult: {
      stops: [], totalDriveSeconds: 3600, totalDriveMinutes: 60,
      totalDwellMinutes: 30, totalTripSeconds: 5400, totalDistanceMiles: 60,
      startTime: '09:00:00', endTime: '10:30:00', timezonesCrossed: [],
    },
    googleMapsRoute: mapsRoute(1),
    onOpenExportModal: vi.fn(),
    onOpenRouteSelector: vi.fn(),
    currentTripName: 'A very long itinerary title that must give way to the header actions',
    onRenameTrip: vi.fn(),
    onToggleScout: vi.fn(),
    onSaveTrip: vi.fn(),
    authEnabled: true,
    authUser: user,
    onLogout: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal('document', undefined);
});

afterEach(() => {
  act(() => { mounted.splice(0).forEach((app) => app.unmount()); });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Account disclosure', () => {
  it('starts with only a decorative avatar/initials and a native accessible button', () => {
    const app = mount(<AccountMenu user={user} onLogout={vi.fn()} />);
    const trigger = button(app, 'Account');
    expect(trigger.type).toBe('button');
    expect(trigger.props.title).toBe('Account');
    expect(trigger.props['aria-expanded']).toBe(false);
    expect(trigger.props['aria-haspopup']).toBe('dialog');
    expect(trigger.props['aria-controls']).toEqual(expect.any(String));
    expect(trigger.findByProps({ 'aria-hidden': 'true' }).children).toEqual(['AR']);
    expect(app.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
    expect(JSON.stringify(app.toJSON())).not.toContain(user.name);
    expect(JSON.stringify(app.toJSON())).not.toContain(user.email);
    expect(app.root.findAllByProps({ 'aria-label': 'Sign out' })).toHaveLength(0);
  });

  it('opens a non-modal dialog containing the full identity and only the sign-out action', () => {
    const longUser = { ...user, name: 'A'.repeat(180), email: `${'e'.repeat(180)}@example.com` };
    const app = mount(<AccountMenu user={longUser} onLogout={vi.fn()} />);
    act(() => button(app, 'Account').props.onClick());
    const panel = app.root.findByProps({ role: 'dialog' });
    expect(panel.props.id).toBe(button(app, 'Account').props['aria-controls']);
    expect(panel.props['aria-label']).toBe('Account');
    expect(panel.props['aria-modal']).not.toBe(true);
    expect(button(app, 'Account').props['aria-expanded']).toBe(true);
    expect(text(panel)).toBe(`${longUser.name}${longUser.email}Sign out`);
    expect(panel.findAllByType('button')).toHaveLength(1);
    expect(button(app, 'Sign out').props.title).toBe('Sign out');
    expect(panel.props.className).toContain('max-w-[calc(100vw-2rem)]');
    expect(panel.findAll((node) => typeof node.props.className === 'string' && node.props.className.includes('[overflow-wrap:anywhere]'))).toHaveLength(1);
    expect(app.root.findAllByProps({ role: 'menu' })).toHaveLength(0);
  });

  it('calls logout once and closes the disclosure', () => {
    const onLogout = vi.fn();
    const app = mount(<AccountMenu user={user} onLogout={onLogout} />);
    act(() => button(app, 'Account').props.onClick());
    act(() => button(app, 'Sign out').props.onClick());
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(button(app, 'Account').props['aria-expanded']).toBe(false);
    expect(app.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
  });

  it.each([
    { name: '  Alex  Morgan Rivera  ', expected: 'AR' },
    { name: 'Alex', expected: 'A' },
    { name: ' ', expected: 'A' },
  ])('uses first/last initials for "$name"', ({ name, expected }) => {
    const app = mount(<AccountMenu user={{ ...user, name }} />);
    expect(text(button(app, 'Account'))).toBe(expected);
  });

  it('uses a decorative image and falls back to initials on load failure', () => {
    const app = mount(<AccountMenu user={{ ...user, picture: 'https://example.com/avatar.png' }} />);
    const image = app.root.findByType('img');
    expect(image.props.alt).toBe('');
    act(() => image.props.onError());
    expect(app.root.findAllByType('img')).toHaveLength(0);
    expect(text(button(app, 'Account'))).toBe('AR');
  });

  function focusHarness(onLogout: (() => void) | null = vi.fn()) {
    const documentStub = new EventTarget();
    vi.stubGlobal('document', documentStub);
    const trigger = { focus: vi.fn() };
    const panel = { focus: vi.fn() };
    const signOut = { focus: vi.fn() };
    const outside = { focus: vi.fn() };
    const root = { contains: (target: unknown) => target === trigger || target === panel || target === signOut };
    const app = mount(<AccountMenu user={user} onLogout={onLogout || undefined} />, {
      createNodeMock: (element: React.ReactElement): object | null => {
        const props = element.props as { 'aria-label'?: string; role?: string } | undefined;
        if (element.type === 'button') return props?.['aria-label'] === 'Account' ? trigger : signOut;
        if (props?.role === 'dialog') return panel;
        if (element.type === 'div') return root;
        return null;
      },
    });
    function dispatch(type: string, target: object, key?: string) {
      const event = new Event(type, { cancelable: true });
      Object.defineProperty(event, 'target', { value: target });
      if (key) Object.defineProperty(event, 'key', { value: key });
      act(() => { documentStub.dispatchEvent(event); });
      return event;
    }
    act(() => button(app, 'Account').props.onClick());
    return { app, trigger, panel, signOut, outside, dispatch, documentStub };
  }

  it('focuses sign out on open, leaves Tab native, and restores trigger focus on Escape', () => {
    const { app, trigger, signOut, dispatch } = focusHarness();
    expect(signOut.focus).toHaveBeenCalledTimes(1);
    expect(dispatch('keydown', signOut, 'Tab').defaultPrevented).toBe(false);
    expect(button(app, 'Account').props['aria-expanded']).toBe(true);
    expect(dispatch('keydown', signOut, 'Escape').defaultPrevented).toBe(true);
    expect(trigger.focus).toHaveBeenCalledTimes(1);
    expect(button(app, 'Account').props['aria-expanded']).toBe(false);
  });

  it('focuses the panel when no sign-out action is supplied', () => {
    const { app, panel, signOut } = focusHarness(null);
    expect(panel.focus).toHaveBeenCalledTimes(1);
    expect(signOut.focus).not.toHaveBeenCalled();
    expect(app.root.findAllByProps({ 'aria-label': 'Sign out' })).toHaveLength(0);
  });

  it('restores trigger focus before pending logout and retains it after logout fails', async () => {
    let rejectLogout!: (reason: Error) => void;
    const pendingLogout = new Promise<void>((_resolve, reject) => { rejectLogout = reject; });
    const onLogout = vi.fn(() => {
      expect(trigger.focus).toHaveBeenCalledTimes(1);
      return pendingLogout;
    });
    const { app, trigger } = focusHarness(onLogout);

    act(() => button(app, 'Sign out').props.onClick());
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(trigger.focus).toHaveBeenCalledTimes(1);
    expect(button(app, 'Account').props['aria-expanded']).toBe(false);
    expect(app.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);

    const rejection = expect(pendingLogout).rejects.toThrow('Sign out failed');
    await act(async () => {
      rejectLogout(new Error('Sign out failed'));
      await rejection;
    });
    expect(trigger.focus).toHaveBeenCalledTimes(1);
    expect(button(app, 'Account').props['aria-expanded']).toBe(false);
  });

  it.each(['pointerdown', 'focusin'])('dismisses on outside %s without stealing target focus', (eventType) => {
    const { app, trigger, signOut, outside, dispatch } = focusHarness();
    dispatch(eventType, signOut);
    expect(button(app, 'Account').props['aria-expanded']).toBe(true);
    expect(dispatch(eventType, outside).defaultPrevented).toBe(false);
    expect(button(app, 'Account').props['aria-expanded']).toBe(false);
    expect(trigger.focus).not.toHaveBeenCalled();
    expect(outside.focus).not.toHaveBeenCalled();
  });

  it('removes document listeners when unmounted while open', () => {
    const { app, documentStub } = focusHarness();
    const remove = vi.spyOn(documentStub, 'removeEventListener');
    act(() => app.unmount());
    expect(remove.mock.calls.map(([eventType]) => eventType)).toEqual(['pointerdown', 'focusin', 'keydown']);
  });
});

describe('Single-row AppHeader', () => {
  it.each([
    { authEnabled: false, authUser: user },
    { authEnabled: true, authUser: null },
  ])('does not disclose account controls unless auth is enabled with a user', (auth) => {
    const app = mount(<AppHeader {...headerProps(auth)} />);
    expect(app.root.findAllByType(AccountMenu)).toHaveLength(0);
    expect(JSON.stringify(app.toJSON())).not.toContain(user.email);
  });

  it('keeps title display/edit paths shrinkable and exposes stable action names', () => {
    const props = headerProps();
    const app = mount(<AppHeader {...props} />);
    const header = app.root.findByType('header');
    expect(header.props.className).toContain('h-14');
    const left = header.children[0] as ReactTestInstance;
    const right = header.children[1] as ReactTestInstance;
    expect(left.props.className).toContain('flex-1');
    expect(left.props.className).toContain('min-w-0');
    expect(left.props.className).not.toContain('shrink-0');
    expect(right.props.className).toContain('shrink-0');
    expect(right.props.className).toContain('whitespace-nowrap');
    expect(button(app, 'Account').props.title).toBe('Account');
    for (const label of ['Switch itinerary', 'Trip schedule', 'Route Scout', 'Save itinerary', 'Export itinerary']) {
      expect(button(app, label).props.title).toEqual(expect.any(String));
    }
    const rename = app.root.findByProps({ title: 'Rename this trip' });
    expect(rename.props.className).toContain('min-w-0');
    expect(rename.findByType('span').props.className).toContain('truncate');
    act(() => rename.props.onClick());
    const input = app.root.findByType('input');
    expect(input.props.className).toContain('min-w-0');
    expect(input.props.className).toContain('max-w-full');
    act(() => input.props.onChange({ target: { value: 'Renamed trip' } }));
    act(() => app.root.findByType('input').props.onBlur());
    expect(props.onRenameTrip).toHaveBeenCalledWith('Renamed trip');
  });

  it('preserves schedule modes and selector, Scout, save and export callbacks', () => {
    const props = headerProps({ isDirty: true });
    const app = mount(<AppHeader {...props} />);
    act(() => button(app, 'Trip schedule').props.onClick());
    for (const [label, mode] of [['Depart At', 'forward'], ['Catch-Up', 'backward'], ['Ad-Hoc', 'adhoc']]) {
      const modeButton = app.root.find((node) => node.type === 'button' && text(node) === label);
      act(() => modeButton.props.onClick());
      expect(props.setSchedulingMode).toHaveBeenCalledWith(mode);
    }
    for (const [label, callback] of [
      ['Switch itinerary', props.onOpenRouteSelector],
      ['Route Scout', props.onToggleScout],
      ['Save itinerary', props.onSaveTrip],
      ['Export itinerary', props.onOpenExportModal],
    ] as const) {
      act(() => button(app, label).props.onClick());
      expect(callback).toHaveBeenCalledTimes(1);
    }
    expect(text(button(app, 'Save itinerary'))).toContain('Save *');
    act(() => app.update(<AppHeader {...props} saveSuccess />));
    expect(text(button(app, 'Save itinerary'))).toBe('Saved!');
    act(() => app.update(<AppHeader {...props} isSaving />));
    expect(button(app, 'Save itinerary').props.disabled).toBe(true);
    act(() => app.update(<AppHeader {...props} isLoadingRoute aiAvailable={false} />));
    expect(button(app, 'Save itinerary').props.disabled).toBe(true);
    expect(button(app, 'Export itinerary').props.disabled).toBe(true);
    expect(button(app, 'Route Scout').props.disabled).toBe(true);
    expect(button(app, 'Route Scout').props.onClick).toBeUndefined();
  });

  it('bounds the schedule panel and allows Ad-Hoc explanatory text to wrap', () => {
    const app = mount(<AppHeader {...headerProps({ schedulingMode: 'adhoc' })} />);
    act(() => button(app, 'Trip schedule').props.onClick());
    const explanation = app.root.findByType('p');
    expect(text(explanation)).toContain('Departure time is captured');
    const panel = explanation.parent?.parent;
    expect(panel?.props.className).toContain('w-80');
    expect(panel?.props.className).toContain('max-w-[calc(100vw-2rem)]');
    expect(panel?.props.className).toContain('whitespace-normal');
    expect(panel?.props.className).not.toContain('w-76');
    for (const label of ['Depart At', 'Catch-Up', 'Ad-Hoc']) {
      expect(panel?.findAll((node) => node.type === 'button' && text(node) === label)).toHaveLength(1);
    }
  });

  it('preserves single- and multi-leg Maps navigation and copy actions', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const props = headerProps();
    const app = mount(<AppHeader {...props} />);
    expect(app.root.findByType('a').props.href).toBe('https://maps.example/0');
    await act(async () => button(app, 'Copy Google Maps navigation link').props.onClick());
    expect(writeText).toHaveBeenLastCalledWith('https://maps.example/0');
    act(() => app.update(<AppHeader {...props} googleMapsRoute={mapsRoute(2)} />));
    act(() => button(app, 'Google Maps navigation links (2 legs)').props.onClick());
    expect(app.root.findAllByType('a').map((link) => link.props.href)).toEqual(['https://maps.example/0', 'https://maps.example/1']);
    await act(async () => button(app, 'Copy Google Maps link for Leg 2').props.onClick());
    expect(writeText).toHaveBeenLastCalledWith('https://maps.example/1');
  });
});
