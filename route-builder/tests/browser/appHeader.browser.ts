import { test as base, expect, type Locator, type Page } from '@playwright/test';
import type { AuthStatusResponse } from '../../src/types/auth';
import type { RouteResponse, Waypoint } from '../../src/types/routing';

const ORIGIN = 'http://127.0.0.1:5174';
const FILE_NAME = 'sample_itinerary.json';
const TRIP_NAME = 'An exceptionally long Southwest road trip through red rock canyons, mountain overlooks, historic towns, and desert vistas';
const USER_NAME = 'Alexandria ' + 'Very Long Browser Regression Driver Name '.repeat(4);
const USER_EMAIL = 'alexandria.' + 'verylongallowlistedroadtripdriver'.repeat(5) + '@example.test';
const AUTH_STATUS: AuthStatusResponse = {
  authEnabled: true,
  authenticated: true,
  authorized: true,
  user: {
    sub: 'browser-test',
    name: USER_NAME,
    email: USER_EMAIL,
    picture: 'https://avatar.example.test/browser-test.png',
  },
};

function gate(open: boolean) {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  if (open) release();
  return { promise, release };
}

function itinerary(pointCount: number) {
  const checkpoints: Waypoint[] = Array.from({ length: pointCount }, (_, index) => ({
    id: `browser-stop-${index}`,
    name: `Southwest scenic stop ${index + 1}`,
    type: index === 0 ? 'origin' : index === pointCount - 1 ? 'destination' : 'scenic_pull_off',
    lat: 33.4357 + index * 0.08,
    lng: -112.0152 + index * 0.02,
    timezone: 'America/Phoenix',
    dwell_minutes: index === 0 || index === pointCount - 1 ? 0 : 15,
    trigger_radius_miles: 0.5,
  }));
  return {
    trip_name: TRIP_NAME,
    dates: { start: '2026-10-20', end: '2026-10-20' },
    metadata: { version: '2.0.0', author: 'Browser regression fixture' },
    days: [{
      day: 1,
      date: '2026-10-20',
      title: 'Red rock overlooks',
      timezone: 'America/Phoenix',
      departure_time: '09:00:00',
      scheduling_mode: 'forward',
      checkpoints,
    }],
  };
}

function routingResponse(url: URL): RouteResponse {
  const coordinates = (url.searchParams.get('coords') || '').split(';').map((coordinate): [number, number] => {
    const [lng, lat] = coordinate.split(',').map(Number);
    return [lng, lat];
  });
  expect(coordinates.length).toBeGreaterThanOrEqual(2);
  expect(coordinates.every((coordinate) => coordinate.every(Number.isFinite))).toBe(true);
  const legs = coordinates.slice(1).map(() => ({
    distanceMeters: 16093.44,
    distanceMiles: 10,
    durationSeconds: 1800,
    durationMinutes: 30,
  }));
  return {
    geometry: { type: 'LineString', coordinates },
    distanceMeters: legs.length * 16093.44,
    distanceMiles: legs.length * 10,
    durationSeconds: legs.length * 1800,
    durationMinutes: legs.length * 30,
    legs,
    cached: false,
  };
}

interface BrowserApi {
  routeRequests: number;
  authRequests: number;
  logoutRequests: number;
  savedBodies: unknown[];
  releaseRouting: () => void;
  releaseSave: () => void;
  allowAuth: () => void;
}

interface BrowserOptions {
  pointCount: number;
  holdRouting: boolean;
  holdAuth: boolean;
}

const test = base.extend<BrowserOptions & { api: BrowserApi }>({
  pointCount: [4, { option: true }],
  holdRouting: [false, { option: true }],
  holdAuth: [false, { option: true }],
  api: async ({ page, pointCount, holdRouting, holdAuth }, use) => {
    const routeGate = gate(!holdRouting);
    const saveGate = gate(false);
    const authGate = gate(!holdAuth);
    const unexpectedRequests: string[] = [];
    const sample = itinerary(pointCount);
    let pendingAuth = holdAuth;
    let loggedOut = false;
    const api: BrowserApi = {
      routeRequests: 0,
      authRequests: 0,
      logoutRequests: 0,
      savedBodies: [],
      releaseRouting: routeGate.release,
      releaseSave: saveGate.release,
      // Existing pending requests stay held; only a new retry is allowed through.
      allowAuth: () => { pendingAuth = false; },
    };

    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== ORIGIN) {
        await route.abort('blockedbyclient');
        return;
      }
      if (!url.pathname.startsWith('/api/')) {
        await route.continue();
        return;
      }
      const endpoint = `${request.method()} ${url.pathname}`;
      switch (endpoint) {
        case 'GET /api/auth/status':
          api.authRequests += 1;
          if (pendingAuth) await authGate.promise;
          await route.fulfill({ json: loggedOut ? { ...AUTH_STATUS, authenticated: false, authorized: false, user: null } : AUTH_STATUS });
          return;
        case 'POST /api/auth/logout':
          api.logoutRequests += 1;
          loggedOut = true;
          await route.fulfill({ json: { success: true } });
          return;
        case 'GET /api/ai/status':
          await route.fulfill({ json: { available: true } });
          return;
        case 'GET /api/ai/scout/quick-prompts':
          await route.fulfill({ json: { prompts: [] } });
          return;
        case `GET /api/itineraries/${FILE_NAME}`:
          await route.fulfill({ json: sample });
          return;
        case 'GET /api/routing/route': {
          const response = routingResponse(url);
          api.routeRequests += 1;
          await routeGate.promise;
          await route.fulfill({ json: response });
          return;
        }
        case `POST /api/itineraries/${FILE_NAME}`:
          api.savedBodies.push(JSON.parse(request.postData() || 'null') as unknown);
          await saveGate.promise;
          await route.fulfill({ json: { success: true, fileName: FILE_NAME, filePath: `/fixtures/${FILE_NAME}` } });
          return;
        default:
          unexpectedRequests.push(endpoint);
          await route.fulfill({ status: 500, json: { error: `Missing browser fixture: ${endpoint}` } });
      }
    });

    try {
      await use(api);
    } finally {
      // Always settle held handlers before removing routes, including on assertion failure.
      routeGate.release();
      saveGate.release();
      authGate.release();
      await page.unrouteAll({ behavior: 'wait' });
      expect(unexpectedRequests, 'No API request may reach a backend or use an implicit fixture').toEqual([]);
    }
  },
});

async function assertHeaderGeometry(page: Page, state: string) {
  const errors = await page.getByRole('banner').evaluate((header) => {
    const problems: string[] = [];
    const bounds = header.getBoundingClientRect();
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
        style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.opacity !== '0';
    };
    const describe = (element: Element) => element.getAttribute('aria-label') || element.getAttribute('title') ||
      element.textContent?.trim().slice(0, 70) || element.tagName;
    const withinHeader = (element: Element) => {
      const rect = element.getBoundingClientRect();
      if (rect.left < Math.max(0, bounds.left) - 1 || rect.right > Math.min(innerWidth, bounds.right) + 1 ||
        rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1) {
        problems.push(`Out of header/viewport bounds: ${describe(element)} ${JSON.stringify(rect.toJSON())}`);
      }
    };
    const noOverlap = (elements: Element[], label: string) => {
      for (let left = 0; left < elements.length; left += 1) {
        for (let right = left + 1; right < elements.length; right += 1) {
          const a = elements[left].getBoundingClientRect();
          const b = elements[right].getBoundingClientRect();
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) {
            problems.push(`${label} overlap: ${describe(elements[left])} / ${describe(elements[right])}`);
          }
        }
      }
    };
    if (Math.abs(bounds.height - 56) > 0.5) problems.push(`Header height is ${bounds.height}, expected 56`);
    if (header.scrollWidth > header.clientWidth + 1) problems.push(`Header scroll width ${header.scrollWidth} > ${header.clientWidth}`);
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) problems.push('Document overflows horizontally');
    const groups = Array.from(header.children).filter(visible);
    const controls = Array.from(header.querySelectorAll('button, a[href], input, select')).filter(visible);
    groups.forEach(withinHeader);
    controls.forEach(withinHeader);
    noOverlap(groups, 'Top-level group');
    noOverlap(controls, 'Control');
    return problems;
  });
  expect(errors, state).toEqual([]);
}

async function assertViewportBounded(locator: Locator) {
  const dimensions = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    };
  });
  expect(dimensions.left).toBeGreaterThanOrEqual(0);
  expect(dimensions.top).toBeGreaterThanOrEqual(0);
  expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.bottom).toBeLessThanOrEqual(dimensions.viewportHeight);
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

async function expectAccountDetails(page: Page) {
  const panel = page.getByRole('dialog', { name: 'Account', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(USER_NAME, { exact: true })).toBeVisible();
  await expect(panel.getByText(USER_EMAIL, { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Sign out', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Account', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await assertViewportBounded(panel);
}

test.describe('App header single-row browser geometry', () => {
  for (const width of [1024, 1280, 1366, 1440, 1536, 1920]) {
    for (const [mode, pointCount] of [['single-leg', 4], ['multi-leg', 14]] as const) {
      test.describe(`${width}px ${mode}`, () => {
        test.use({ viewport: { width, height: 900 }, pointCount, holdRouting: true });

        test('keeps long content, routing, inline edit, dirty and saving states within one row', async ({ page, api }) => {
          await page.goto('/');
          const header = page.getByRole('banner');
          const account = header.getByRole('button', { name: 'Account', exact: true });
          const save = header.getByRole('button', { name: 'Save itinerary', exact: true });
          const exportButton = header.getByRole('button', { name: 'Export itinerary', exact: true });
          await expect(account).toBeVisible();
          await expect(header.getByTitle('Rename this trip')).toHaveText(TRIP_NAME);
          await expect.poll(() => api.routeRequests).toBeGreaterThan(0);
          await expect(save).toBeDisabled();
          await expect(exportButton).toBeDisabled();
          await assertHeaderGeometry(page, `${width}px ${mode}: routing`);

          api.releaseRouting();
          await expect(save).toBeEnabled();
          await expect(exportButton).toBeEnabled();
          await assertHeaderGeometry(page, `${width}px ${mode}: routed with positive distance and dwell`);
          if (width >= 1280) {
            await expect(header.getByTitle('Total Drive Distance')).toBeVisible();
            await expect(header.getByTitle('Total Driving Time')).toBeVisible();
          }
          if (width >= 1536) {
            await expect(header.getByTitle('Total Elapsed Time (Drive + Stops)')).toBeVisible();
          }
          for (const name of ['Trip schedule', 'Switch itinerary', 'Route Scout', 'Export itinerary']) {
            // Trial clicks check native hit-testing/actionability, not just render-tree presence.
            await header.getByRole('button', { name, exact: true }).click({ trial: true });
          }
          if (mode === 'single-leg') {
            const maps = header.getByTitle('Open navigation in Google Maps');
            await expect(maps).toHaveAttribute('href', /^https:\/\/www\.google\.com\/maps\/dir\//);
            await maps.click({ trial: true });
            await header.getByTitle('Copy Google Maps navigation link').click({ trial: true });
          } else {
            const maps = header.getByTitle('View Google Maps multi-leg links');
            await maps.click();
            const links = header.getByRole('link', { name: 'Open', exact: true });
            await expect(links).toHaveCount(2);
            for (const link of await links.all()) {
              await expect(link).toHaveAttribute('href', /^https:\/\/www\.google\.com\/maps\/dir\//);
              await link.click({ trial: true });
            }
            await maps.click();
          }

          await header.getByTitle('Rename this trip').click();
          const editor = header.getByRole('textbox');
          await expect(editor).toBeFocused();
          await expect(editor).toHaveValue(TRIP_NAME);
          const renamed = ('Renamed ' + TRIP_NAME).slice(0, 80);
          await editor.fill(renamed);
          await assertHeaderGeometry(page, `${width}px ${mode}: focused title input`);
          await editor.press('Enter');
          await expect(header.getByTitle('Rename this trip')).toHaveText(renamed);
          await expect(save).toHaveAttribute('title', /Unsaved changes/i);
          await assertHeaderGeometry(page, `${width}px ${mode}: dirty title`);

          await save.click();
          await expect.poll(() => api.savedBodies.length).toBe(1);
          expect(api.savedBodies[0]).toMatchObject({ content: { trip_name: renamed } });
          await expect(save).toBeDisabled();
          await assertHeaderGeometry(page, `${width}px ${mode}: saving`);
          api.releaseSave();
          await expect(save).toBeEnabled();
          await expect(save).toHaveAttribute('title', /All changes saved/i);
          await assertHeaderGeometry(page, `${width}px ${mode}: saved`);

          await expect(page.getByRole('dialog', { name: 'Account', exact: true })).toHaveCount(0);
          await expect(header.getByText(USER_NAME, { exact: true })).toHaveCount(0);
          await expect(header.getByText(USER_EMAIL, { exact: true })).toHaveCount(0);
          await expect(header.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
          await account.click();
          await expectAccountDetails(page);
          await page.keyboard.press('Escape');
          await expect(account).toBeFocused();
          await expect(account).toHaveAttribute('aria-expanded', 'false');
        });
      });
    }
  }
});

test.describe('Trip schedule dropdown browser geometry', () => {
  for (const width of [1024, 1366]) {
    test.describe(`${width}px`, () => {
      test.use({ viewport: { width, height: 900 } });

      test('wraps Ad-Hoc guidance without clipping text or mode controls', async ({ page, api }) => {
        await page.goto('/');
        await expect.poll(() => api.routeRequests).toBeGreaterThan(0);
        await expect(page.getByRole('button', { name: 'Save itinerary', exact: true })).toBeEnabled();
        const schedule = page.getByRole('button', { name: 'Trip schedule', exact: true });
        await schedule.click();
        const panel = page.getByText('Trip Schedule', { exact: true }).locator('..').locator('..');
        await expect(panel).toBeVisible();
        await assertViewportBounded(panel);
        await panel.getByRole('button', { name: 'Ad-Hoc', exact: true }).click();
        await expect(panel.getByText('Dynamic Drive Offsets', { exact: true })).toBeVisible();
        const paragraph = panel.locator('p').filter({ hasText: 'Departure time is captured when you begin driving in the car.' });
        await expect(paragraph).toHaveText('Departure time is captured when you begin driving in the car. Checkpoints calculate arrival times dynamically based on cumulative drive and dwell durations.');
        await assertViewportBounded(panel);
        await assertViewportBounded(paragraph);

        const textProblems = await panel.evaluate((element) => {
          const problems: string[] = [];
          const panelBounds = element.getBoundingClientRect();
          for (const content of Array.from(element.querySelectorAll('button, p'))) {
            const bounds = content.getBoundingClientRect();
            const label = content.textContent?.trim() || content.tagName;
            if (bounds.left < panelBounds.left || bounds.right > panelBounds.right ||
              bounds.top < panelBounds.top || bounds.bottom > panelBounds.bottom) {
              problems.push(`Content outside panel: ${label}`);
            }
            if (content.scrollWidth > content.clientWidth + 1 || content.scrollHeight > content.clientHeight + 1) {
              problems.push(`Content internally overflows: ${label}`);
            }
            // Range boxes expose text spilling or clipped by overflow:hidden, even when the element itself fits.
            const range = document.createRange();
            range.selectNodeContents(content);
            const lines = Array.from(range.getClientRects());
            for (const line of lines) {
              if (line.left < Math.max(0, bounds.left) - 1 || line.right > Math.min(innerWidth, bounds.right) + 1 ||
                line.top < bounds.top - 1 || line.bottom > Math.min(innerHeight, bounds.bottom) + 1) {
                problems.push(`Rendered text clipped or outside bounds: ${label}`);
              }
            }
            if (content.tagName === 'P' && new Set(lines.map((line) => line.top)).size < 2) {
              problems.push('Ad-Hoc guidance does not wrap onto multiple lines');
            }
          }
          return problems;
        });
        expect(textProblems, `${width}px Ad-Hoc panel text and controls`).toEqual([]);
        for (const name of ['Depart At', 'Catch-Up', 'Ad-Hoc']) {
          await panel.getByRole('button', { name, exact: true }).click({ trial: true });
        }
        await panel.getByRole('button', { name: 'Depart At', exact: true }).click();
        await expect(paragraph).toHaveCount(0);
        await panel.getByRole('button', { name: 'Ad-Hoc', exact: true }).click();
        await expect(paragraph).toBeVisible();
        await schedule.click();
        await expect(panel).toHaveCount(0);
      });
    });
  }
});

test.describe('Account menu real keyboard and pointer behavior', () => {
  test.use({ viewport: { width: 1280, height: 900 } });
  test.beforeEach(async ({ page, api }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Account', exact: true })).toBeVisible();
    await expect.poll(() => api.routeRequests).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Save itinerary', exact: true })).toBeEnabled();
  });

  for (const key of ['Enter', 'Space']) {
    test(`opens from native ${key} activation with an avatar-only trigger`, async ({ page }) => {
      const account = page.getByRole('button', { name: 'Account', exact: true });
      await expect(account).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(account).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('dialog', { name: 'Account', exact: true })).toHaveCount(0);
      await expect(account).not.toContainText(USER_NAME);
      await expect(account).not.toContainText(USER_EMAIL);
      await account.focus();
      await account.press(key);
      await expectAccountDetails(page);
    });
  }

  test('Escape dismisses from inside the panel and restores trigger focus', async ({ page }) => {
    const account = page.getByRole('button', { name: 'Account', exact: true });
    await account.click();
    await expectAccountDetails(page);
    const signOut = page.getByRole('dialog', { name: 'Account', exact: true }).getByRole('button', { name: 'Sign out', exact: true });
    await signOut.focus();
    await signOut.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Account', exact: true })).toHaveCount(0);
    await expect(account).toHaveAttribute('aria-expanded', 'false');
    await expect(account).toBeFocused();
  });

  test('an outside pointer click dismisses the panel', async ({ page }) => {
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await expectAccountDetails(page);
    await page.getByRole('heading', { name: 'Roadtrip Co-Pilot', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Account', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Account', exact: true })).toHaveAttribute('aria-expanded', 'false');
  });

  test('Tab moving focus outside dismisses without returning focus to the trigger', async ({ page }) => {
    const account = page.getByRole('button', { name: 'Account', exact: true });
    await account.click();
    await expectAccountDetails(page);
    const signOut = page.getByRole('dialog', { name: 'Account', exact: true }).getByRole('button', { name: 'Sign out', exact: true });
    await signOut.focus();
    await signOut.press('Tab');
    await expect(page.getByRole('dialog', { name: 'Account', exact: true })).toHaveCount(0);
    await expect(account).not.toBeFocused();
    await expect(account).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => document.activeElement?.matches('button, a[href], input, select, textarea, [tabindex]'))).toBe(true);
  });

  test('Sign out sends the mocked POST and returns to the sign-in gate', async ({ page, api }) => {
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await expectAccountDetails(page);
    const logout = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/auth/logout' && request.method() === 'POST');
    await page.getByRole('dialog', { name: 'Account', exact: true }).getByRole('button', { name: 'Sign out', exact: true }).click();
    await logout;
    await expect.poll(() => api.logoutRequests).toBe(1);
    await expect(page.getByRole('banner')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Continue with Google', exact: true })).toBeVisible();
  });

  test('keyboard logout preserves trigger focus while pending and after 503, then allows retry', async ({ page, api }) => {
    const logoutGate = gate(false);
    let attempts = 0;
    await page.route('**/api/auth/logout', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      attempts += 1;
      if (attempts === 1) {
        await logoutGate.promise;
        await route.fulfill({ status: 503, json: { error: 'Logout temporarily unavailable' } });
        return;
      }
      await route.fallback();
    });

    try {
      const account = page.getByRole('button', { name: 'Account', exact: true });
      const panel = page.getByRole('dialog', { name: 'Account', exact: true });
      await account.focus();
      await page.keyboard.press('Enter');
      await expectAccountDetails(page);
      await expect(panel.getByRole('button', { name: 'Sign out', exact: true })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect.poll(() => attempts).toBe(1);
      await expect(panel).toHaveCount(0);
      await expect(account).toHaveAttribute('aria-expanded', 'false');
      await expect(account).toBeFocused();
      await expect(page.getByRole('banner')).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);

      const failure = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/logout' && response.status() === 503);
      logoutGate.release();
      await failure;
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(page.getByRole('alert')).toContainText('Failed to sign out (Logout failed with status 503). Please try again.');
      await expect(panel).toHaveCount(0);
      await expect(account).toBeFocused();

      // Do not focus the trigger again: retry must work from the focus retained through the failed request.
      await page.keyboard.press('Enter');
      await expectAccountDetails(page);
      await expect(panel.getByRole('button', { name: 'Sign out', exact: true })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect.poll(() => attempts).toBe(2);
      await expect.poll(() => api.logoutRequests).toBe(1);
      await expect(page.getByRole('banner')).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Continue with Google', exact: true })).toBeVisible();
    } finally {
      logoutGate.release();
    }
  });
});

test.describe('Auth recovery browser smoke', () => {
  test.use({ viewport: { width: 1280, height: 900 }, holdAuth: true });

  test('pending auth never flashes the studio, times out, and Retry restores the real header', async ({ page, api }) => {
    await page.clock.install({ time: new Date('2026-10-20T12:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-20T12:00:01Z'));
    await page.goto('/');
    await expect.poll(() => api.authRequests).toBeGreaterThan(0);
    await expect(page.getByRole('banner')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Continue with Google', exact: true })).toHaveCount(0);
    const connecting = page.getByRole('status').filter({ hasText: /connecting/i });
    await page.clock.runFor(749);
    await expect(connecting).toHaveCount(0);
    await page.clock.runFor(1);
    await expect(connecting).toBeVisible();
    await expect(page.getByRole('banner')).toHaveCount(0);
    await page.clock.runFor(14250);
    const retry = page.getByRole('button', { name: /Retry/ });
    await expect(retry).toBeVisible();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('banner')).toHaveCount(0);
    await expect(connecting).toHaveCount(0);

    api.allowAuth();
    await page.clock.resume();
    await retry.click();
    await expect(page.getByRole('button', { name: 'Account', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save itinerary', exact: true })).toBeEnabled();
    await expect(page.getByRole('banner').getByTitle('Rename this trip')).toHaveText(TRIP_NAME);
    await expect(retry).toHaveCount(0);
    await assertHeaderGeometry(page, 'recovered auth');
  });
});
