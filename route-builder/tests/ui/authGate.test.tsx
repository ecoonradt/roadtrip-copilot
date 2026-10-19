import React from 'react';
import * as renderer from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, it, expect, vi } from 'vitest';
import { act, api, mountApp } from './harness';
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
});
