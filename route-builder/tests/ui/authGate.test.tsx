import React from 'react';
import * as renderer from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, it, expect, vi } from 'vitest';
import { act, api, mountApp, fixture, points } from './harness';
import { AuthGateScreen } from '../../src/components/AuthGateScreen';

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

  it('renders user pill and sign out button in AppHeader when authEnabled and authUser are provided', async () => {
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

    const textContent = allText(headerElement.root);
    expect(textContent).toContain('Road Driver');
    expect(textContent).toContain('Sign Out');

    const signOutButton = headerElement.root
      .findAllByType('button')
      .find((b) => b.props.title === 'Sign out');
    expect(signOutButton).toBeDefined();

    await act(async () => {
      signOutButton!.props.onClick();
    });
    expect(onLogout).toHaveBeenCalledTimes(1);
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
      .mockRejectedValueOnce(new Error('Network offline'))
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
    expect(api.fetchItinerary).toHaveBeenCalledTimes(3);

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

    // The recovered trip was NOT overwritten by late failure fallback
    expect(headerEl.props.currentTripName).toBe('Recovered Trip Name');
  });

  it('does not overwrite newly selected or imported trip when pending retry itinerary request resolves late', async () => {
    // Initial mount: auth fails, and itinerary request hangs
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

    api.fetchItinerary.mockReturnValue(pendingItineraryPromise as Promise<never>);

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

    // Studio is rendered while the initial itinerary request is still pending
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
});


