import React from 'react';
import * as renderer from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, it, expect, vi } from 'vitest';
import { act, api, mountApp, fixture, points } from './harness';
import { AuthGateScreen } from '../../src/components/AuthGateScreen';
import type { AuthStatusResponse } from '../../src/types/auth';

const signedInStatus: AuthStatusResponse = {
  authEnabled: true,
  authenticated: true,
  authorized: true,
  user: { sub: 'driver-1', email: 'pilot@example.com', name: 'Pilot' },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function advanceTime(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

function retryButton(app: renderer.ReactTestRenderer): ReactTestInstance {
  return app.root.findAllByType('button').find((button) => allText(button) === 'Retry Connection')!;
}

async function retryConnection(app: renderer.ReactTestRenderer): Promise<void> {
  await act(async () => {
    retryButton(app).props.onClick();
    await Promise.resolve();
  });
}

function allText(node: ReactTestInstance): string {
  return node.children
    .map((child) =>
      typeof child === 'string'
        ? child
        : typeof child === 'number'
        ? String(child)
        : allText(child)
    )
    .join(' ');
}

describe('Frontend Auth UI & Gating', () => {
  it('keeps a quiet dark background before showing delayed connection feedback without flashing studio or login UI', async () => {
    const authCheck = deferred<AuthStatusResponse>();
    api.fetchAuthStatus.mockReturnValue(authCheck.promise);
    const app = await mountApp();

    // While auth status is in flight, studio header, sidebar, map, and AuthGateScreen are NOT rendered
    expect(app.root.findAllByType('test-header')).toHaveLength(0);
    expect(app.root.findAllByType('test-sidebar')).toHaveLength(0);
    expect(app.root.findAllByType('test-map')).toHaveLength(0);
    expect(app.root.findAllByType(AuthGateScreen)).toHaveLength(0);

    // Instead, a clean solid blue background container (bg-slate-950) is rendered
    const rootDiv = app.root.findByType('div');
    expect(rootDiv.props.className).toContain('bg-slate-950');
    expect(allText(app.root)).toBe('');
    expect(app.root.findAllByProps({ role: 'status' })).toHaveLength(0);

    await advanceTime(749);
    expect(allText(app.root)).toBe('');
    await advanceTime(1);
    expect(allText(app.root.findByProps({ role: 'status' }))).toBe('Connecting to Roadtrip Co-Pilot…');
    expect(app.root.findAllByType('test-header')).toHaveLength(0);
    expect(app.root.findAllByType(AuthGateScreen)).toHaveLength(0);

    // Settle the auth check with unauthenticated status
    await act(async () => {
      authCheck.resolve({
        authEnabled: true,
        authenticated: false,
        authorized: false,
        user: null,
      });
      await Promise.resolve();
    });

    // Now AuthGateScreen is displayed and studio header is still absent
    expect(app.root.findByType(AuthGateScreen)).toBeDefined();
    expect(app.root.findAllByType('test-header')).toHaveLength(0);
    expect(app.root.findAllByProps({ role: 'status' })).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renders AuthGateScreen with "Continue with Google" link to /api/auth/google when unauthenticated and does not render test-header', async () => {
    api.fetchAuthStatus.mockResolvedValue({
      authEnabled: true,
      authenticated: false,
      authorized: false,
      user: null,
    });

    const app = await mountApp();
    await act(async () => {
      await Promise.resolve();
    });

    // Does not render main studio header
    expect(app.root.findAllByType('test-header')).toHaveLength(0);

    // Renders AuthGateScreen with Continue with Google link
    const gateScreen = app.root.findByType(AuthGateScreen);
    expect(gateScreen).toBeDefined();

    const googleLink = app.root.findByType('a');
    expect(googleLink.props.href).toBe('/api/auth/google');

    const textContent = allText(app.root);
    expect(textContent).toContain('Continue with Google');
    expect(textContent).toContain('Sign in to continue');
  });

  it('renders 403 Private Preview restriction message displaying user email and clicking Sign Out calls api.logoutAuth and transitions to unauthenticated Google Sign-In', async () => {
    api.fetchAuthStatus.mockResolvedValue({
      authEnabled: true,
      authenticated: true,
      authorized: false,
      user: {
        sub: '123',
        email: 'guest@example.com',
        name: 'Guest User',
      },
      message: 'Roadtrip Co-Pilot is in private preview.',
    });

    const app = await mountApp();
    await act(async () => {
      await Promise.resolve();
    });

    // Does not render main studio header
    expect(app.root.findAllByType('test-header')).toHaveLength(0);

    const textContent = allText(app.root);
    expect(textContent).toContain('Private Preview — Access Restricted');
    expect(textContent).toContain('Roadtrip Co-Pilot is in private preview.');
    expect(textContent).toContain('guest@example.com');
    expect(textContent).toContain('Guest User');

    // Find and click the Sign Out button
    const signOutBtn = app.root
      .findAllByType('button')
      .find((b) => allText(b).includes('Sign Out & Use Another Account'));
    expect(signOutBtn).toBeDefined();

    await act(async () => {
      signOutBtn!.props.onClick();
      await Promise.resolve();
    });

    // Verifies api.logoutAuth was called
    expect(api.logoutAuth).toHaveBeenCalledTimes(1);

    // Transitions to the unauthenticated Google Sign-In screen
    const postLogoutText = allText(app.root);
    expect(postLogoutText).toContain('Continue with Google');
    expect(postLogoutText).toContain('Sign in to continue');

    const googleLink = app.root.findByType('a');
    expect(googleLink.props.href).toBe('/api/auth/google');
  });

  it('renders the studio and passes authEnabled: true and authUser to AppHeader when authenticated and authorized', async () => {
    const user = {
      sub: '1',
      email: 'pilot@example.com',
      name: 'Pilot',
    };
    api.fetchAuthStatus.mockResolvedValue({
      authEnabled: true,
      authenticated: true,
      authorized: true,
      user,
    });

    const app = await mountApp();
    await act(async () => {
      await Promise.resolve();
    });

    const header = app.root.findByType('test-header');
    expect(header).toBeDefined();
    expect(header.props.authEnabled).toBe(true);
    expect(header.props.authUser).toEqual(user);
  });

  it('shows user details and sign out only after opening the header account popover', async () => {
    const { AppHeader } = await vi.importActual<typeof import('../../src/components/AppHeader')>(
      '../../src/components/AppHeader'
    );

    const onLogout = vi.fn();
    const user = {
      sub: '1',
      email: 'driver@example.com',
      name: 'Road Driver',
    };

    let headerElement!: renderer.ReactTestRenderer;
    await act(async () => {
      headerElement = renderer.create(
        <AppHeader
          route={null}
          isLoadingRoute={false}
          routeError={null}
          baseDate="2026-10-09"
          setBaseDate={vi.fn()}
          departureTime="09:00:00"
          setDepartureTime={vi.fn()}
          schedulingMode="forward"
          setSchedulingMode={vi.fn()}
          targetArrivalTime="18:00:00"
          setTargetArrivalTime={vi.fn()}
          backwardInfo={null}
          cascadeResult={{
            stops: [],
            totalDriveSeconds: 0,
            totalTripSeconds: 0,
            totalDistanceMiles: 0,
            arrivalTargetMet: true,
          }}
          googleMapsRoute={{
            legs: [],
            totalLegs: 0,
            primaryUrl: '',
          }}
          onOpenExportModal={vi.fn()}
          authEnabled={true}
          authUser={user}
          onLogout={onLogout}
        />
      );
    });

    expect(allText(headerElement.root)).not.toContain('Road Driver');
    expect(allText(headerElement.root)).not.toContain('driver@example.com');
    expect(headerElement.root.findAllByProps({ role: 'dialog', 'aria-label': 'Account' })).toHaveLength(0);
    await act(async () => {
      headerElement.root.findByProps({ 'aria-label': 'Account' }).props.onClick();
    });

    const accountDialog = headerElement.root.findByProps({ role: 'dialog', 'aria-label': 'Account' });
    const textContent = allText(accountDialog);
    expect(textContent).toContain('Road Driver');
    expect(textContent).toContain('driver@example.com');

    const signOutButton = headerElement.root
      .findAllByType('button')
      .find((b) => b.props.title === 'Sign out');
    expect(signOutButton).toBeDefined();

    await act(async () => {
      signOutButton!.props.onClick();
    });
    expect(onLogout).toHaveBeenCalledTimes(1);
    await act(async () => headerElement.unmount());
  });

  it('renders Connection Issue alert and Retry Connection button when authStatus has error message', async () => {
    api.fetchAuthStatus.mockResolvedValue({
      authEnabled: true,
      authenticated: false,
      authorized: false,
      user: null,
      message: 'Unable to connect to authentication server. Please check your connection and retry.',
    });

    const app = await mountApp();
    await act(async () => {
      await Promise.resolve();
    });

    const textContent = allText(app.root);
    expect(textContent).toContain('Connection Issue');
    expect(textContent).toContain('Unable to connect to authentication server');
    expect(textContent).toContain('Retry Connection');

    // Click Retry Connection
    const retryBtn = app.root
      .findAllByType('button')
      .find((b) => allText(b).includes('Retry Connection'));
    expect(retryBtn).toBeDefined();

    await act(async () => {
      retryBtn!.props.onClick();
      await Promise.resolve();
    });

    expect(api.fetchAuthStatus).toHaveBeenCalled();
  });

  it('does not transition to signed-out screen when logout fails and displays error feedback', async () => {
    api.fetchAuthStatus.mockResolvedValue({
      authEnabled: true,
      authenticated: true,
      authorized: false,
      user: {
        sub: '123',
        email: 'guest@example.com',
        name: 'Guest User',
      },
      message: 'Roadtrip Co-Pilot is in private preview.',
    });
    api.logoutAuth.mockRejectedValue(new Error('Logout failed with status 500'));

    const app = await mountApp();
    await act(async () => {
      await Promise.resolve();
    });

    const signOutBtn = app.root
      .findAllByType('button')
      .find((b) => allText(b).includes('Sign Out & Use Another Account'));
    expect(signOutBtn).toBeDefined();

    await act(async () => {
      signOutBtn!.props.onClick();
      await Promise.resolve();
    });

    // Verifies api.logoutAuth was called
    expect(api.logoutAuth).toHaveBeenCalledTimes(1);

    // Does NOT transition to unauthenticated "Continue with Google" screen
    const textContent = allText(app.root);
    expect(textContent).not.toContain('Sign in to continue');
    expect(textContent).toContain('guest@example.com');
    // Displays error feedback
    expect(textContent).toContain('Failed to sign out');
  });

  it('re-queries itinerary and AI status when clicking Retry Connection, restoring trip data and readiness', async () => {
    api.fetchAuthStatus.mockRejectedValueOnce(new Error('Network offline'));
    api.fetchAiStatus.mockRejectedValueOnce(new Error('Network offline'));
    api.fetchItinerary
      .mockRejectedValueOnce(new Error('Network offline'));

    const app = await mountApp();
    await act(async () => {
      await Promise.resolve();
    });

    // Verify initial connection issue screen
    const initialText = allText(app.root);
    expect(initialText).toContain('Connection Issue');
    expect(initialText).toContain('Retry Connection');

    // Setup recovered network responses
    const validTripFixture = fixture();
    api.fetchAuthStatus.mockResolvedValue({
      authEnabled: true,
      authenticated: true,
      authorized: true,
      user: { sub: 'driver-1', email: 'pilot@example.com', name: 'Pilot' },
    });
    api.fetchAiStatus.mockResolvedValue({ available: true });
    api.fetchItinerary.mockResolvedValue(validTripFixture);

    const retryBtn = app.root
      .findAllByType('button')
      .find((b) => allText(b).includes('Retry Connection'));
    expect(retryBtn).toBeDefined();

    await act(async () => {
      retryBtn!.props.onClick();
      await Promise.resolve();
    });

    // Verifies all three services were re-queried
    expect(api.fetchAuthStatus).toHaveBeenCalledTimes(2);
    expect(api.fetchAiStatus).toHaveBeenCalledTimes(2);
    expect(api.fetchItinerary).toHaveBeenCalledTimes(2);

    // Transitions to the studio with loaded trip and AI readiness restored
    const headerEl = app.root.findByType('test-header');
    expect(headerEl).toBeDefined();
    expect(headerEl.props.authEnabled).toBe(true);
    expect(headerEl.props.aiAvailable).toBe(true);
    expect(headerEl.props.currentTripName).toBe('Scheduling tests');
  });

  it('ignores superseded itinerary load when an earlier pending request fails late', async () => {
    // Initial mount: auth fails, and itinerary request hangs
    api.fetchAuthStatus.mockResolvedValue({
      authEnabled: true,
      authenticated: false,
      authorized: false,
      message: 'Initial network error',
    });
    api.fetchAiStatus.mockRejectedValue(new Error('offline'));

    let rejectFirstItinerary!: (reason?: unknown) => void;
    const firstItineraryPromise = new Promise((_resolve, reject) => {
      rejectFirstItinerary = reject;
    });

    // First call hangs; second call (retry) resolves immediately
    const recoveredTrip = fixture();
    recoveredTrip.trip_name = 'Recovered Trip Name';

    api.fetchItinerary
      .mockReturnValueOnce(firstItineraryPromise as Promise<never>)
      .mockResolvedValue(recoveredTrip);

    const app = await mountApp();
    await act(async () => {
      await Promise.resolve();
    });

    expect(allText(app.root)).toContain('Connection Issue');

    // User clicks Retry Connection
    api.fetchAuthStatus.mockResolvedValue({
      authEnabled: true,
      authenticated: true,
      authorized: true,
      user: { sub: 'driver-1', email: 'driver@example.com', name: 'Driver' },
    });
    api.fetchAiStatus.mockResolvedValue({ available: true });

    const retryBtn = app.root
      .findAllByType('button')
      .find((b) => allText(b).includes('Retry Connection'));

    await act(async () => {
      retryBtn!.props.onClick();
      await Promise.resolve();
    });

    // Recovered trip is rendered
    const headerEl = app.root.findByType('test-header');
    expect(headerEl.props.currentTripName).toBe('Recovered Trip Name');

    // Now the original pending itinerary request fails late
    await act(async () => {
      rejectFirstItinerary(new Error('Late network timeout'));
      await Promise.resolve();
    });

    // The recovered trip was NOT overwritten by the late failure
    expect(headerEl.props.currentTripName).toBe('Recovered Trip Name');
  });

  it('does not overwrite newly selected or imported trip when pending retry itinerary request resolves late', async () => {
    // Initial mount: auth fails, but the initial trip loads behind the auth gate
    api.fetchAuthStatus.mockResolvedValue({
      authEnabled: true,
      authenticated: false,
      authorized: false,
      message: 'Connection failure',
    });
    api.fetchAiStatus.mockRejectedValue(new Error('offline'));

    let resolvePendingItinerary!: (value: unknown) => void;
    const pendingItineraryPromise = new Promise((resolve) => {
      resolvePendingItinerary = resolve;
    });

    api.fetchItinerary.mockResolvedValueOnce(fixture()).mockReturnValue(pendingItineraryPromise as Promise<never>);

    const app = await mountApp();
    await act(async () => {
      await Promise.resolve();
    });

    expect(allText(app.root)).toContain('Connection Issue');

    // User clicks Retry Connection which restores auth
    api.fetchAuthStatus.mockResolvedValue({
      authEnabled: true,
      authenticated: true,
      authorized: true,
      user: { sub: 'driver-1', email: 'driver@example.com', name: 'Driver' },
    });
    api.fetchAiStatus.mockResolvedValue({ available: true });

    const retryBtn = app.root
      .findAllByType('button')
      .find((b) => allText(b).includes('Retry Connection'));

    await act(async () => {
      retryBtn!.props.onClick();
      await Promise.resolve();
    });

    // Studio is available because a trip is already active while the retry request is pending
    expect(app.root.findAllByType('test-header')).toHaveLength(1);

    // User deliberately imports / selects another trip
    const importedTrip = {
      tripName: 'Imported User Route',
      isMultiDay: false,
      isAdHoc: false,
      fileName: 'imported_route.json',
      days: [
        {
          dayNumber: 1,
          title: 'Day 1',
          date: '2026-10-20',
          departureTime: '08:00:00',
          timezone: 'America/Phoenix',
          schedulingMode: 'forward' as const,
          isAdHoc: false,
          waypoints: points(1),
        },
      ],
    };

    const { selectTrip } = await import('./harness');
    await act(async () => {
      selectTrip(app, importedTrip);
      await Promise.resolve();
    });

    const headerEl = app.root.findByType('test-header');
    expect(headerEl.props.currentTripName).toBe('Imported User Route');

    // User edits the trip (e.g. changes departure time)
    await act(async () => {
      headerEl.props.setDepartureTime('10:00:00');
      await Promise.resolve();
    });
    expect(headerEl.props.departureTime).toBe('10:00:00');

    // Now the pending retry itinerary request resolves late with old trip data
    const lateServerTrip = fixture();
    lateServerTrip.trip_name = 'Stale Overwriting Route';

    await act(async () => {
      resolvePendingItinerary(lateServerTrip);
      await Promise.resolve();
    });

    // The imported trip and edits must NOT be overwritten by the late server response
    expect(headerEl.props.currentTripName).toBe('Imported User Route');
    expect(headerEl.props.departureTime).toBe('10:00:00');
  });

  it('cancels delayed feedback and the deadline after immediate auth success', async () => {
    api.fetchAuthStatus.mockResolvedValue(signedInStatus);
    const app = await mountApp();

    expect(app.root.findAllByType('test-header')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await advanceTime(15_000);
    expect(app.root.findAllByProps({ role: 'status' })).toHaveLength(0);
    expect(app.root.findAllByType(AuthGateScreen)).toHaveLength(0);
    expect(api.fetchAuthStatus).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out and aborts a never-responding transport that ignores its signal without opening the workspace', async () => {
    api.fetchAuthStatus.mockReturnValue(new Promise<AuthStatusResponse>(() => {}));
    const app = await mountApp();
    const signal = api.fetchAuthStatus.mock.calls[0][0] as AbortSignal;

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    await advanceTime(14_999);
    expect(app.root.findAllByType(AuthGateScreen)).toHaveLength(0);
    expect(allText(app.root)).toBe('Connecting to Roadtrip Co-Pilot…');
    await advanceTime(1);

    expect(signal.aborted).toBe(true);
    const gate = app.root.findByType(AuthGateScreen);
    expect(gate.props.status).toMatchObject({
      authEnabled: true,
      authenticated: false,
      authorized: false,
      user: null,
    });
    const alertText = allText(app.root.findByProps({ role: 'alert' }));
    expect(alertText).toContain('Connection Issue');
    expect(alertText).toContain('timed out');
    expect(alertText).toContain('check your connection and retry');
    expect(retryButton(app)).toBeDefined();
    expect(app.root.findAllByType('test-header')).toHaveLength(0);
    expect(app.root.findAllByType('test-map')).toHaveLength(0);
    expect(api.fetchItinerary).toHaveBeenCalledTimes(1);
    expect(api.fetchAiStatus).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes the signal to native fetch and applies the same deadline while the response body is pending', async () => {
    const actualApi = await vi.importActual<typeof import('../../src/services/api')>('../../src/services/api');
    const body = deferred<AuthStatusResponse>();
    const response = new Response();
    const readBody = vi.spyOn(response, 'json').mockReturnValue(body.promise);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    api.fetchAuthStatus.mockImplementation(actualApi.fetchAuthStatus);

    const app = await mountApp();
    const signal = api.fetchAuthStatus.mock.calls[0][0] as AbortSignal;
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/status', { credentials: 'same-origin', signal });
    expect(readBody).toHaveBeenCalledTimes(1);
    await advanceTime(15_000);

    expect(signal.aborted).toBe(true);
    expect(allText(app.root.findByProps({ role: 'alert' }))).toContain('timed out');
    await act(async () => body.resolve(signedInStatus));
    expect(app.root.findAllByType('test-header')).toHaveLength(0);
    expect(allText(app.root)).toContain('timed out');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the same delayed feedback and deadline on every retry and recovers only once after success', async () => {
    api.fetchAuthStatus.mockRejectedValueOnce(new Error('Offline'));
    const app = await mountApp();
    const initialTripCalls = api.fetchItinerary.mock.calls.length;
    api.fetchAuthStatus.mockReturnValue(new Promise<AuthStatusResponse>(() => {}));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Even a retained click handler cannot create two simultaneous retries.
      const retry = retryButton(app);
      await act(async () => {
        retry.props.onClick();
        retry.props.onClick();
      });
      expect(api.fetchAuthStatus).toHaveBeenCalledTimes(attempt + 2);
      expect(app.root.findAllByType(AuthGateScreen)).toHaveLength(0);
      expect(allText(app.root)).toBe('');
      await advanceTime(749);
      expect(allText(app.root)).toBe('');
      await advanceTime(1);
      expect(allText(app.root.findByProps({ role: 'status' }))).toBe('Connecting to Roadtrip Co-Pilot…');
      await advanceTime(14_249);
      expect(app.root.findAllByType(AuthGateScreen)).toHaveLength(0);
      await advanceTime(1);
      expect(allText(app.root.findByProps({ role: 'alert' }))).toContain('timed out');
      expect(app.root.findAllByType('test-header')).toHaveLength(0);
      expect(api.fetchItinerary).toHaveBeenCalledTimes(initialTripCalls);
      expect(api.fetchAiStatus).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    }

    api.fetchAuthStatus.mockResolvedValue(signedInStatus);
    api.fetchAiStatus.mockResolvedValue({ available: true });
    const recovered = fixture();
    recovered.trip_name = 'Recovered after repeated timeouts';
    api.fetchItinerary.mockResolvedValue(recovered);
    await retryConnection(app);

    const header = app.root.findByType('test-header');
    expect(header.props.currentTripName).toBe('Recovered after repeated timeouts');
    expect(header.props.aiAvailable).toBe(true);
    expect(header.props.authUser).toEqual(signedInStatus.user);
    expect(api.fetchAuthStatus).toHaveBeenCalledTimes(4);
    expect(api.fetchItinerary).toHaveBeenCalledTimes(initialTripCalls + 1);
    expect(api.fetchAiStatus).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await advanceTime(15_000);
    expect(app.root.findAllByType(AuthGateScreen)).toHaveLength(0);
  });

  it.each([
    { label: 'signed out', authenticated: false, authorized: false },
    { label: 'not allowlisted', authenticated: true, authorized: false },
  ])('does not reload trip or AI after a retry reports $label', async ({ authenticated, authorized }) => {
    api.fetchAuthStatus.mockRejectedValueOnce(new Error('Offline'));
    const app = await mountApp();
    api.fetchAuthStatus.mockResolvedValue({ ...signedInStatus, authenticated, authorized });
    await retryConnection(app);

    expect(app.root.findAllByType('test-header')).toHaveLength(0);
    expect(app.root.findAllByType(AuthGateScreen)).toHaveLength(1);
    expect(api.fetchItinerary).toHaveBeenCalledTimes(1);
    expect(api.fetchAiStatus).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers trip and AI exactly once when retry confirms the local auth-disabled mode', async () => {
    api.fetchAuthStatus.mockRejectedValueOnce(new Error('Offline'));
    const app = await mountApp();
    api.fetchAuthStatus.mockResolvedValue({
      authEnabled: false,
      authenticated: true,
      authorized: true,
      user: null,
    });
    api.fetchAiStatus.mockResolvedValue({ available: true });
    await retryConnection(app);

    expect(app.root.findByType('test-header').props.authEnabled).toBe(false);
    expect(app.root.findByType('test-header').props.aiAvailable).toBe(true);
    expect(api.fetchItinerary).toHaveBeenCalledTimes(2);
    expect(api.fetchAiStatus).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  for (const stage of ['timeout', 'retry pending', 'recovered'] as const) {
    it.each(['success', 'failure'] as const)(`ignores initial late %s while ${stage} without erasing current auth or recovery`, async (outcome) => {
      const initial = deferred<AuthStatusResponse>();
      const current = deferred<AuthStatusResponse>();
      api.fetchAuthStatus.mockReturnValueOnce(initial.promise).mockReturnValue(current.promise);
      api.fetchAiStatus.mockRejectedValueOnce(new Error('Offline')).mockResolvedValue({ available: true });
      api.fetchItinerary
        .mockRejectedValueOnce(new Error('Offline'))
        .mockResolvedValue(fixture());
      const app = await mountApp();
      await advanceTime(15_000);

      if (stage !== 'timeout') {
        await retryConnection(app);
        if (stage === 'recovered') {
          await act(async () => current.resolve(signedInStatus));
        } else {
          await advanceTime(750);
        }
      }

      await act(async () => {
        if (outcome === 'success') initial.resolve(signedInStatus);
        else initial.reject(new Error('Late failure from timed-out check'));
      });

      if (stage === 'timeout') {
        expect(allText(app.root.findByProps({ role: 'alert' }))).toContain('timed out');
        expect(app.root.findAllByType('test-header')).toHaveLength(0);
        expect(api.fetchAuthStatus).toHaveBeenCalledTimes(1);
        await retryConnection(app);
      } else if (stage === 'retry pending') {
        expect(allText(app.root.findByProps({ role: 'status' }))).toBe('Connecting to Roadtrip Co-Pilot…');
        expect(app.root.findAllByType(AuthGateScreen)).toHaveLength(0);
        expect(app.root.findAllByType('test-header')).toHaveLength(0);
        expect(api.fetchItinerary).toHaveBeenCalledTimes(1);
        expect(api.fetchAiStatus).toHaveBeenCalledTimes(1);
      }

      if (stage !== 'recovered') await act(async () => current.resolve(signedInStatus));
      const header = app.root.findByType('test-header');
      expect(header.props.authUser).toEqual(signedInStatus.user);
      expect(header.props.currentTripName).toBe('Scheduling tests');
      expect(header.props.aiAvailable).toBe(true);
      expect(api.fetchItinerary).toHaveBeenCalledTimes(2);
      expect(api.fetchAiStatus).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      await advanceTime(15_000);
      expect(app.root.findAllByType(AuthGateScreen)).toHaveLength(0);
      expect(api.fetchItinerary).toHaveBeenCalledTimes(2);
      expect(api.fetchAiStatus).toHaveBeenCalledTimes(2);
    });
  }

  for (const stage of ['initial', 'retry'] as const) {
    it.each(['success', 'failure'] as const)(`clears pending ${stage} timers on unmount and ignores late %s`, async (outcome) => {
      const pending = deferred<AuthStatusResponse>();
      if (stage === 'retry') api.fetchAuthStatus.mockRejectedValueOnce(new Error('Offline'));
      api.fetchAuthStatus.mockReturnValue(pending.promise);
      const app = await mountApp();
      if (stage === 'retry') await retryConnection(app);

      const signal = api.fetchAuthStatus.mock.calls.at(-1)![0] as AbortSignal;
      expect(vi.getTimerCount()).toBe(2);
      await act(async () => app.unmount());
      expect(signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await act(async () => {
        if (outcome === 'success') pending.resolve(signedInStatus);
        else pending.reject(new Error('Late failure after unmount'));
      });
      await advanceTime(15_000);
      expect(app.toJSON()).toBeNull();
      expect(api.fetchItinerary).toHaveBeenCalledTimes(1);
      expect(api.fetchAiStatus).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it('invalidates a pending auth retry when an already-requested logout succeeds', async () => {
    api.fetchAuthStatus.mockRejectedValueOnce(new Error('Offline'));
    const app = await mountApp();
    const logout = deferred<void>();
    api.logoutAuth.mockReturnValue(logout.promise);
    await act(async () => {
      void app.root.findByType(AuthGateScreen).props.onLogout();
    });

    const retry = deferred<AuthStatusResponse>();
    api.fetchAuthStatus.mockReturnValue(retry.promise);
    await retryConnection(app);
    const signal = api.fetchAuthStatus.mock.calls.at(-1)![0] as AbortSignal;
    await act(async () => logout.resolve());

    expect(signal.aborted).toBe(true);
    expect(allText(app.root)).toContain('Sign in to continue');
    expect(allText(app.root)).not.toContain('Connection Issue');
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => retry.resolve(signedInStatus));
    expect(app.root.findAllByType('test-header')).toHaveLength(0);
    expect(api.fetchItinerary).toHaveBeenCalledTimes(1);
    expect(api.fetchAiStatus).toHaveBeenCalledTimes(1);
  });
});
