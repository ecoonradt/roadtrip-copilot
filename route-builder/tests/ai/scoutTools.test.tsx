import React from 'react';
import * as renderer from 'react-test-renderer';
import type { ReactTestRenderer } from 'react-test-renderer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';
import {
  SCOUT_TOOL_DECLARATIONS,
  cleanPlaceName,
  assertSafeExternalUrl,
  assertSafeExternalUrlWithDns,
  htmlToReadableText,
  ScoutToolLibrary,
  createTurnGroundingCache,
  type ResolvedPlaceRecord,
  type TurnGroundingCache,
  type ScoutToolExecutionContext,
} from '../../server/services/scoutTools.js';
import {
  ScoutService,
  parseScoutResponse,
  hydrateSuggestionFromResolvedPlaces,
  isValidGooglePlaceId,
} from '../../server/services/scoutService.js';
import { formatBedrockToolLabel, AwsBedrockHarnessAdapter } from '../../server/services/bedrockService.js';
import { RouteService } from '../../server/services/routeService.js';
import { AiService, type AiHarnessAdapter } from '../../server/services/aiService.js';
import { RouteScoutDrawer } from '../../src/components/RouteScoutDrawer.js';
import { chatWithScoutStream, fetchScoutQuickPrompts } from '../../src/services/api.js';
import type { ScoutTripContext, ScoutChatRequest, ScoutStreamEvent } from '../../server/types/scout.js';
import type { ParsedTrip } from '../../src/engine/itineraryParser.js';

// Mock react-dom createPortal so modals and drawers render inline under react-test-renderer
vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return {
    ...actual,
    createPortal: (children: React.ReactNode) => children,
  };
});

// Mock api service for RouteScoutDrawer integration
vi.mock('../../src/services/api.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/api.js')>('../../src/services/api.js');
  return {
    ...actual,
    fetchScoutQuickPrompts: vi.fn().mockResolvedValue([]),
    chatWithScoutStream: vi.fn(),
  };
});

const act = renderer.act;
const create = renderer.create;

const sampleTripContext: ScoutTripContext = {
  tripName: 'Arizona Scenic Highway Run',
  date: '2026-10-10',
  origin: 'Phoenix, AZ',
  destination: 'Flagstaff, AZ',
  departureTime: '08:00:00',
  corridor: 'I-17 North to AZ-179 North to US-89A North',
  waypoints: [
    {
      id: 'wp_origin',
      name: 'Phoenix Departure',
      type: 'origin',
      lat: 33.4484,
      lng: -112.074,
      target_time: '08:00:00',
      dwell_minutes: 0,
    },
    {
      id: 'wp_bell_rock',
      name: 'Bell Rock Scenic Vista',
      type: 'scenic_drive_by',
      lat: 34.8005,
      lng: -111.7667,
      target_time: '10:00:00',
      dwell_minutes: 0,
      trigger_radius_miles: 2.0,
      drive_distance_miles: 100,
      drive_duration_minutes: 100,
      drive_speed_mph: 60,
      is_route_anchor: true,
      notification: {
        title: 'Approaching Bell Rock',
        message: 'Approaching Bell Rock Vista along AZ-179.',
        speech: 'Approaching Bell Rock Scenic Vista ahead on your left.',
      },
    },
    {
      id: 'wp_sedona_lunch',
      name: 'Sedona Cafe',
      type: 'meal',
      lat: 34.8697,
      lng: -111.761,
      target_time: '10:30:00',
      dwell_minutes: 45,
      place_name: 'Sedona Cafe',
      address: '100 Main St, Sedona, AZ 86336',
      google_place_id: 'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q',
      drive_distance_miles: 5,
      drive_duration_minutes: 10,
      drive_speed_mph: 30,
      is_route_anchor: false,
      notification: {
        title: 'Sedona Cafe Ahead',
        message: 'Arriving at Sedona Cafe for lunch.',
        speech: 'Approaching Sedona Cafe ahead for lunch.',
      },
    },
    {
      id: 'wp_dest',
      name: 'Flagstaff Lodging',
      type: 'lodging',
      lat: 35.1983,
      lng: -111.6513,
      target_time: '12:30:00',
      dwell_minutes: 0,
      place_name: 'Flagstaff Motor Inn',
      address: '200 Route 66, Flagstaff, AZ 86001',
      google_place_id: 'ChIJCR3fWhuQO4cRxCLXXbAfCxQ',
      drive_distance_miles: 30,
      drive_duration_minutes: 45,
      drive_speed_mph: 40,
      is_route_anchor: false,
    },
  ],
};

const sampleParsedTrip: ParsedTrip = {
  tripName: 'Arizona Scenic Highway Run',
  days: [
    {
      dayNumber: 1,
      title: 'Day 1: Phoenix to Flagstaff',
      date: '2026-10-10',
      origin: 'Phoenix, AZ',
      destination: 'Flagstaff, AZ',
      departureTime: '08:00:00',
      waypoints: [
        {
          id: 'wp_origin',
          name: 'Phoenix Departure',
          type: 'origin',
          lat: 33.4484,
          lng: -112.074,
          target_time: '08:00:00',
          dwell_minutes: 0,
        },
        {
          id: 'wp_bell_rock',
          name: 'Bell Rock Scenic Vista',
          type: 'scenic_drive_by',
          lat: 34.8005,
          lng: -111.7667,
          target_time: '10:00:00',
          dwell_minutes: 0,
          trigger_radius_miles: 2.0,
          is_route_anchor: true,
          notification: {
            title: 'Approaching Bell Rock',
            message: 'Approaching Bell Rock Vista along AZ-179.',
            speech: 'Approaching Bell Rock Scenic Vista ahead on your left.',
          },
        },
        {
          id: 'wp_sedona_lunch',
          name: 'Sedona Cafe',
          type: 'meal',
          lat: 34.8697,
          lng: -111.761,
          target_time: '10:30:00',
          dwell_minutes: 45,
          place_name: 'Sedona Cafe',
          address: '100 Main St, Sedona, AZ 86336',
          google_place_id: 'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q',
          is_route_anchor: false,
          notification: {
            title: 'Sedona Cafe Ahead',
            message: 'Arriving at Sedona Cafe for lunch.',
            speech: 'Approaching Sedona Cafe ahead for lunch.',
          },
        },
        {
          id: 'wp_dest',
          name: 'Flagstaff Lodging',
          type: 'lodging',
          lat: 35.1983,
          lng: -111.6513,
          target_time: '12:30:00',
          dwell_minutes: 0,
          place_name: 'Flagstaff Motor Inn',
          address: '200 Route 66, Flagstaff, AZ 86001',
          google_place_id: 'ChIJCR3fWhuQO4cRxCLXXbAfCxQ',
          is_route_anchor: false,
        },
      ],
    },
  ],
};

describe('Route Scout Grounding Tools & Isolation', () => {
  const mounted: ReactTestRenderer[] = [];
  const storageEntries = new Map<string, string>();

  beforeEach(() => {
    storageEntries.clear();
    (fetchScoutQuickPrompts as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storageEntries.get(key) ?? null,
      setItem: (key: string, value: string) => storageEntries.set(key, value),
      removeItem: (key: string) => storageEntries.delete(key),
    });

    const documentStub = new EventTarget();
    Object.assign(documentStub, {
      body: { style: {} },
    });
    vi.stubGlobal('document', documentStub);

    const windowStub = new EventTarget();
    Object.assign(windowStub, {
      location: { href: 'http://localhost:5173' },
    });
    vi.stubGlobal('window', windowStub);
  });

  afterEach(() => {
    for (const inst of mounted) {
      try {
        act(() => {
          inst.unmount();
        });
      } catch {
        // ignore unmount errors
      }
    }
    mounted.length = 0;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
  });

  // =========================================================================
  // 1. SCOUT_TOOL_DECLARATIONS & cleanPlaceName
  // =========================================================================
  describe('1. SCOUT_TOOL_DECLARATIONS & cleanPlaceName', () => {
    it('exports all 7 canonical Route Scout tool declarations with valid JSON schemas', () => {
      expect(SCOUT_TOOL_DECLARATIONS).toHaveLength(7);

      const expectedToolNames = [
        'search_web',
        'read_url_content',
        'resolve_and_standardize_place',
        'snap_to_highway_corridor',
        'calculate_detour_impact',
        'simulate_schedule_cascade',
        'audit_corridor_waypoints',
      ];

      const declaredNames = SCOUT_TOOL_DECLARATIONS.map((t) => t.name);
      expect(declaredNames).toEqual(expectedToolNames);

      for (const tool of SCOUT_TOOL_DECLARATIONS) {
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
        expect(tool.description.length).toBeGreaterThan(10);
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeDefined();
      }

      // Check specific required fields
      const searchWeb = SCOUT_TOOL_DECLARATIONS.find((t) => t.name === 'search_web');
      expect(searchWeb?.inputSchema.required).toEqual(['query']);

      const readUrl = SCOUT_TOOL_DECLARATIONS.find((t) => t.name === 'read_url_content');
      expect(readUrl?.inputSchema.required).toEqual(['url']);

      const resolvePlace = SCOUT_TOOL_DECLARATIONS.find((t) => t.name === 'resolve_and_standardize_place');
      expect(resolvePlace?.inputSchema.required).toEqual(['query']);

      const snap = SCOUT_TOOL_DECLARATIONS.find((t) => t.name === 'snap_to_highway_corridor');
      expect(snap?.inputSchema.required).toEqual(['lat', 'lng']);

      const detour = SCOUT_TOOL_DECLARATIONS.find((t) => t.name === 'calculate_detour_impact');
      expect(detour?.inputSchema.required).toEqual(['candidate_lat', 'candidate_lng', 'after_waypoint_id']);

      const cascade = SCOUT_TOOL_DECLARATIONS.find((t) => t.name === 'simulate_schedule_cascade');
      expect(cascade?.inputSchema.required).toEqual(['action', 'target_waypoint_id']);

      const audit = SCOUT_TOOL_DECLARATIONS.find((t) => t.name === 'audit_corridor_waypoints');
      expect(audit?.inputSchema.properties?.day_number).toBeDefined();
    });

    it('cleanPlaceName strips parenthetical qualifiers and slash prefixes', () => {
      // Direct requirement cases:
      expect(cleanPlaceName('Maverik (West Main St)')).toBe('Maverik');
      expect(cleanPlaceName('Flagstaff / Little America Hotel (East)')).toBe('Little America Hotel');
      expect(cleanPlaceName('Valley Park (Picnic / Rest Area)')).toBe('Valley Park');

      // Additional edge cases:
      expect(cleanPlaceName("Love's Travel Stop (Exit 204)")).toBe("Love's Travel Stop");
      expect(cleanPlaceName('Coconino / Sunset Crater (Visitor Center)')).toBe('Sunset Crater');
      expect(cleanPlaceName('Shell')).toBe('Shell');
      expect(cleanPlaceName('   Flying J (I-40)   ')).toBe('Flying J');
      expect(cleanPlaceName('')).toBe('');
      expect(cleanPlaceName(null as unknown as string)).toBe('');
      expect(cleanPlaceName(undefined as unknown as string)).toBe('');
    });
  });

  // =========================================================================
  // 2. SSRF & Redirect Hardening (assertSafeExternalUrl & read_url_content)
  // =========================================================================
  describe('2. SSRF & Redirect Hardening (assertSafeExternalUrl & read_url_content)', () => {
    it('allows valid HTTPS domains and public IPv6 addresses', () => {
      const parsed1 = assertSafeExternalUrl('https://example.com/guide');
      expect(parsed1.hostname).toBe('example.com');
      expect(parsed1.protocol).toBe('https:');

      const parsed2 = assertSafeExternalUrl('https://[2606:4700:4700::1]/dns-query');
      expect(parsed2.hostname).toBe('[2606:4700:4700::1]');
      expect(parsed2.protocol).toBe('https:');

      const parsed3 = assertSafeExternalUrl('http://roadtrip.guide:8080/scenic-routes?state=az');
      expect(parsed3.hostname).toBe('roadtrip.guide');
      expect(parsed3.port).toBe('8080');
    });

    it('rejects non-HTTP(S) schemes', () => {
      expect(() => assertSafeExternalUrl('file:///etc/passwd')).toThrow(/protocol must be http: or https:/);
      expect(() => assertSafeExternalUrl('ftp://example.com/data.txt')).toThrow(/protocol must be http: or https:/);
      expect(() => assertSafeExternalUrl('javascript:alert(1)')).toThrow(/protocol must be http: or https:/);
      expect(() => assertSafeExternalUrl('gopher://evil.com/')).toThrow(/protocol must be http: or https:/);
      expect(() => assertSafeExternalUrl('data:text/plain;base64,SGVsbG8=')).toThrow(/protocol must be http: or https:/);
    });

    it('rejects credentials in URL', () => {
      expect(() => assertSafeExternalUrl('https://user:pass@example.com')).toThrow(/credentials in URL are forbidden/);
      expect(() => assertSafeExternalUrl('http://admin@internal.site.com/')).toThrow(/credentials in URL are forbidden/);
    });

    it('rejects localhost, sub.localhost, internal.local, and cloud metadata hostnames', () => {
      const blockedHostnames = [
        'http://localhost/',
        'http://localhost:3000/api',
        'http://sub.localhost/',
        'http://deep.nested.localhost/',
        'http://internal.local/',
        'http://database.internal.local/',
        'http://service.internal/',
        'http://api.internal/',
        'http://metadata.google.internal/computeMetadata/v1/',
        'http://metadata/latest/meta-data/',
      ];

      for (const url of blockedHostnames) {
        expect(() => assertSafeExternalUrl(url)).toThrow(/forbidden internal hostname/);
      }
    });

    it('rejects private, loopback, link-local, and IMDS IPv4 literals including integer and hex formats', () => {
      const blockedIpv4s = [
        'http://127.0.0.1/',
        'http://127.0.0.2:8080/',
        'http://10.0.0.1/',
        'http://10.254.1.1/',
        'http://172.16.0.1/',
        'http://172.31.255.255/',
        'http://192.168.1.1/',
        'http://192.168.100.50/',
        'http://169.254.169.254/latest/meta-data/',
        'http://169.254.1.1/',
        'http://100.64.0.1/',
        'http://100.127.255.255/',
        'http://0.0.0.0/',
        'http://192.0.0.1/',
        'http://198.18.0.1/',
        'http://224.0.0.1/',
        'http://240.0.0.1/',
      ];

      for (const url of blockedIpv4s) {
        expect(() => assertSafeExternalUrl(url)).toThrow(/private or reserved IPv4 address/);
      }

      // Integer and Hex IPv4 formats normalize to 127.0.0.1 and are blocked by assertSafeExternalUrl
      expect(() => assertSafeExternalUrl('http://2130706433/')).toThrow(/Blocked URL/);
      expect(() => assertSafeExternalUrl('http://0x7f000001/')).toThrow(/Blocked URL/);
    });

    it('rejects private, loopback, link-local, unique-local, and IMDS IPv6 literals', () => {
      const blockedIpv6s = [
        'http://[::1]/', // Loopback
        'http://[::]/', // Unspecified
        'http://[fd00:ec2::254]/latest/meta-data/', // AWS IMDSv2 IPv6
        'http://[fc00::1]/', // Unique local
        'http://[fe80::1]/', // Link-local
        'http://[::ffff:127.0.0.1]/', // IPv4-mapped loopback
        'http://[::ffff:169.254.169.254]/', // IPv4-mapped IMDS
        'http://[64:ff9b::127.0.0.1]/', // NAT64 private
        'http://[2002:7f00:0001::]/', // 6to4 loopback (127.0.0.1)
        'http://[ff02::1]/', // Multicast
        'http://[2001:db8::1]/', // Documentation
      ];

      for (const url of blockedIpv6s) {
        expect(() => assertSafeExternalUrl(url)).toThrow(/Blocked URL/);
      }
    });

    it('read_url_content validates EVERY redirect hop and blocks redirect to AWS IMDS before fetching target', async () => {
      const fetchCalls: string[] = [];
      const mockFetch: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        fetchCalls.push(urlStr);

        if (urlStr === 'https://example.com/start') {
          // Redirecting to AWS IMDS
          return new Response(null, {
            status: 302,
            headers: new Headers({
              Location: 'http://169.254.169.254/latest/meta-data/',
            }),
          });
        }

        if (urlStr.includes('169.254.169.254')) {
          // If this ever executes, SSRF protection failed!
          return new Response('ami-id-123456', { status: 200 });
        }

        return new Response('Not found', { status: 404 });
      });

      const toolLib = new ScoutToolLibrary({ fetchImpl: mockFetch });
      const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

      await expect(
        toolLib.readUrlContent({ url: 'https://example.com/start' }, context)
      ).rejects.toThrow(/private or reserved IPv4 address "169.254.169.254"/);

      // Verify the IMDS target was NEVER fetched
      expect(fetchCalls).toEqual(['https://example.com/start']);
      expect(fetchCalls.some((c) => c.includes('169.254.169.254'))).toBe(false);
    });

    it('read_url_content blocks redirect chains exceeding 3 hops', async () => {
      const mockFetch: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const u = new URL(urlStr);
        const step = parseInt(u.searchParams.get('step') || '1', 10);
        return new Response(null, {
          status: 302,
          headers: new Headers({
            Location: `https://example.com/redirect?step=${step + 1}`,
          }),
        });
      });

      const toolLib = new ScoutToolLibrary({ fetchImpl: mockFetch });
      const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

      await expect(
        toolLib.readUrlContent({ url: 'https://example.com/redirect?step=1' }, context)
      ).rejects.toThrow(/Too many redirects/);
    });

    it('read_url_content rejects binary content types loudly', async () => {
      const binaryCases = [
        { contentType: 'application/pdf', errorMatch: /Unsupported binary content type: "application\/pdf"/ },
        { contentType: 'image/png', errorMatch: /Unsupported binary content type: "image\/png"/ },
        { contentType: 'application/octet-stream', errorMatch: /Unsupported binary content type: "application\/octet-stream"/ },
        { contentType: 'application/zip', errorMatch: /Unsupported binary content type: "application\/zip"/ },
      ];

      for (const tc of binaryCases) {
        const mockFetch: typeof fetch = vi.fn(async () => {
          return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
            status: 200,
            headers: new Headers({ 'content-type': tc.contentType }),
          });
        });

        const toolLib = new ScoutToolLibrary({ fetchImpl: mockFetch });
        const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

        await expect(
          toolLib.readUrlContent({ url: 'https://example.com/file' }, context)
        ).rejects.toThrow(tc.errorMatch);
      }
    });

    it('read_url_content extracts title and clean text from HTML while stripping scripts and styles', async () => {
      const htmlBody = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Sedona Scenic Byway &amp; Overlooks</title>
            <script>console.log("malicious script");</script>
            <style>.hidden { display: none; }</style>
          </head>
          <body>
            <h1>Red Rock &quot;Byway&quot; Guide</h1>
            <p>Welcome to Arizona&#39;s premier scenic drive on AZ-179.</p>
            <div>Featuring pull-offs near Bell Rock &amp; Cathedral Rock.</div>
          </body>
        </html>
      `;

      const mockFetch: typeof fetch = vi.fn(async () => {
        return new Response(htmlBody, {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        });
      });

      const toolLib = new ScoutToolLibrary({ fetchImpl: mockFetch });
      const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

      const result = await toolLib.readUrlContent({ url: 'https://example.com/guide' }, context);

      expect(result.title).toBe('Sedona Scenic Byway & Overlooks');
      expect(result.content).toContain('Red Rock "Byway" Guide');
      expect(result.content).toContain("Welcome to Arizona's premier scenic drive on AZ-179.");
      expect(result.content).toContain('Featuring pull-offs near Bell Rock & Cathedral Rock.');
      expect(result.content).not.toContain('malicious script');
      expect(result.content).not.toContain('.hidden');
      expect(result.truncated).toBe(false);
    });

    it('read_url_content truncates content exceeding maxUrlChars and flags truncated: true', async () => {
      const longText = 'A'.repeat(500);
      const mockFetch: typeof fetch = vi.fn(async () => {
        return new Response(`<p>${longText}</p>`, {
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
        });
      });

      const toolLib = new ScoutToolLibrary({ fetchImpl: mockFetch, maxUrlChars: 100 });
      const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

      const result = await toolLib.readUrlContent({ url: 'https://example.com/long-page' }, context);
      expect(result.truncated).toBe(true);
      expect(result.content.length).toBe(100);
    });
  });

  // =========================================================================
  // 3. search_web & Lazy SSM Secret Resolution
  // =========================================================================
  describe('3. search_web & Lazy SSM Secret Resolution', () => {
    it('search_web sends request to Brave Search with X-Subscription-Token and clamps count to [1, 10]', async () => {
      let capturedUrl = '';
      let capturedHeaders: HeadersInit | undefined = undefined;

      const mockFetch: typeof fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        capturedHeaders = init?.headers;
        return new Response(
          JSON.stringify({
            web: {
              results: [
                {
                  title: 'Sedona Scenic Byway',
                  url: 'https://example.com/sedona',
                  description: 'A 7.5-mile scenic highway through Red Rock Country.',
                },
              ],
            },
          }),
          { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }
        );
      });

      const toolLib = new ScoutToolLibrary({
        braveSearchApiKey: 'test-brave-key-123',
        fetchImpl: mockFetch,
      });
      const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

      // Test with count: 20 (should clamp to 10)
      const res1 = await toolLib.searchWeb({ query: 'Sedona byways', count: 20 }, context);
      expect(capturedUrl).toBe('https://api.search.brave.com/res/v1/web/search?q=Sedona%20byways&count=10');
      expect((capturedHeaders as Record<string, string>)['X-Subscription-Token']).toBe('test-brave-key-123');
      expect(res1.results).toHaveLength(1);
      expect(res1.results[0].title).toBe('Sedona Scenic Byway');

      // Test with count: 0 (should clamp to 1)
      await toolLib.searchWeb({ query: 'Flagstaff motels', count: 0 }, context);
      expect(capturedUrl).toBe('https://api.search.brave.com/res/v1/web/search?q=Flagstaff%20motels&count=1');
    });

    it('resolves Brave key from SSM, caches for 15 minutes, and enforces 30s cooldown on failure', async () => {
      const mockSend = vi.fn().mockResolvedValue({
        Parameters: [
          { Name: '/roadtrip-copilot/brave-search-api-key', Value: 'ssm-resolved-brave-key' },
        ],
      });
      const mockSsmClient = { send: mockSend } as unknown as SSMClient;

      const mockFetch: typeof fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        if (headers['X-Subscription-Token'] !== 'ssm-resolved-brave-key') {
          return new Response('Unauthorized', { status: 401 });
        }
        return new Response(JSON.stringify({ web: { results: [] } }), {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      });

      const toolLib = new ScoutToolLibrary({
        ssmClient: mockSsmClient,
        fetchImpl: mockFetch,
      });
      const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

      // Call 1: triggers SSM resolution
      await toolLib.searchWeb({ query: 'Query 1' }, context);
      expect(mockSend).toHaveBeenCalledTimes(1);

      // Call 2: uses cached key within 15 minutes (mockSend NOT called again)
      await toolLib.searchWeb({ query: 'Query 2' }, context);
      expect(mockSend).toHaveBeenCalledTimes(1);

      // Now test cooldown behavior when SSM resolution fails:
      const failingSsmSend = vi.fn().mockRejectedValue(new Error('SSM Access Denied'));
      const failingSsmClient = { send: failingSsmSend } as unknown as SSMClient;
      const failingToolLib = new ScoutToolLibrary({
        ssmClient: failingSsmClient,
        fetchImpl: mockFetch,
      });

      // Call 1 on failing lib: fails with SSM error
      await expect(
        failingToolLib.searchWeb({ query: 'Query Fail' }, context)
      ).rejects.toThrow('SSM Access Denied');
      expect(failingSsmSend).toHaveBeenCalledTimes(1);

      // Call 2 within 30s: fails immediately with cooldown error without calling SSM again
      await expect(
        failingToolLib.searchWeb({ query: 'Query Fail Again' }, context)
      ).rejects.toThrow(/in retry cooldown/);
      expect(failingSsmSend).toHaveBeenCalledTimes(1);
    });

    it('fails loudly without silent fallback when Brave API returns HTTP 429 or 500', async () => {
      const mockFetch429: typeof fetch = vi.fn(async () => {
        return new Response('Rate limit exceeded', { status: 429 });
      });

      const toolLib429 = new ScoutToolLibrary({
        braveSearchApiKey: 'key',
        fetchImpl: mockFetch429,
      });
      const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

      await expect(
        toolLib429.searchWeb({ query: 'Sedona hikes' }, context)
      ).rejects.toThrow('Brave Search API failed with HTTP 429');

      const mockFetch500: typeof fetch = vi.fn(async () => {
        return new Response('Internal Server Error', { status: 500 });
      });
      const toolLib500 = new ScoutToolLibrary({
        braveSearchApiKey: 'key',
        fetchImpl: mockFetch500,
      });

      await expect(
        toolLib500.searchWeb({ query: 'Sedona hikes' }, context)
      ).rejects.toThrow('Brave Search API failed with HTTP 500');
    });

    it('never invokes SSM for tools that do not require API keys', async () => {
      const mockSend = vi.fn();
      const mockSsmClient = { send: mockSend } as unknown as SSMClient;

      const mockFetch: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (urlStr.includes('router.project-osrm.org/nearest')) {
          return new Response(
            JSON.stringify({
              code: 'Ok',
              waypoints: [{ name: 'AZ-179', location: [-111.7667, 34.8005], distance: 10 }],
            }),
            { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }
          );
        }
        if (urlStr.includes('example.com/guide')) {
          return new Response('<title>Guide</title><p>Hello World</p>', {
            status: 200,
            headers: new Headers({ 'content-type': 'text/html' }),
          });
        }
        return new Response('{}', { status: 200 });
      });

      const mockRouteService = {
        getRoute: vi.fn().mockResolvedValue({
          distanceMiles: 15,
          durationMinutes: 20,
        }),
      } as unknown as RouteService;

      const toolLib = new ScoutToolLibrary({
        ssmClient: mockSsmClient,
        fetchImpl: mockFetch,
        routeService: mockRouteService,
      });
      const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

      // Execute all 5 tools that do not require API keys
      await toolLib.readUrlContent({ url: 'https://example.com/guide' }, context);
      await toolLib.snapToHighwayCorridor({ lat: 34.8005, lng: -111.7667 }, context);
      await toolLib.calculateDetourImpact(
        { candidate_lat: 34.85, candidate_lng: -111.75, after_waypoint_id: 'wp_bell_rock' },
        context
      );
      await toolLib.simulateScheduleCascade(
        { action: 'add', target_waypoint_id: 'wp_bell_rock', candidate_lat: 34.85, candidate_lng: -111.75 },
        context
      );
      await toolLib.auditCorridorWaypoints({}, context);

      // Verify SSM send was NEVER called
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('resolves AWS region without hardcoded us-east-1 fallback', async () => {
      // 1. Explicit options region
      const libOptions = new ScoutToolLibrary({ region: 'us-east-2' });
      const clientOptions = (libOptions as unknown as { getSsmClient: () => SSMClient }).getSsmClient();
      expect(await clientOptions.config.region()).toBe('us-east-2');

      // 2. process.env.AWS_REGION
      process.env.AWS_REGION = 'eu-west-1';
      const libEnv = new ScoutToolLibrary({});
      const clientEnv = (libEnv as unknown as { getSsmClient: () => SSMClient }).getSsmClient();
      expect(await clientEnv.config.region()).toBe('eu-west-1');
    });
  });

  // =========================================================================
  // 4. resolve_and_standardize_place (Google Places API New)
  // =========================================================================
  describe('4. resolve_and_standardize_place (Google Places API New)', () => {
    it('sends POST to Google Places API (New) with field mask and clamps radius to 50000m', async () => {
      let capturedUrl = '';
      let capturedHeaders: HeadersInit | undefined = undefined;
      let capturedBody: Record<string, unknown> | undefined = undefined;

      const mockFetch: typeof fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        capturedHeaders = init?.headers;
        if (init?.body) {
          capturedBody = JSON.parse(init.body as string);
        }

        return new Response(
          JSON.stringify({
            places: [
              {
                id: 'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q',
                displayName: { text: 'Maverik (West Main St)' },
                formattedAddress: '123 Main St, Flagstaff, AZ 86001',
                location: { latitude: 35.1983, longitude: -111.6513 },
                types: ['gas_station', 'convenience_store'],
              },
            ],
          }),
          { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }
        );
      });

      const toolLib = new ScoutToolLibrary({
        googlePlacesApiKey: 'test-google-key-456',
        fetchImpl: mockFetch,
      });

      const groundingCache = createTurnGroundingCache(sampleTripContext.waypoints);
      const context: ScoutToolExecutionContext = {
        tripContext: sampleTripContext,
        groundingCache,
      };

      // Call with radius_miles: 100 (which exceeds 50km hard limit)
      const res = await toolLib.resolveAndStandardizePlace(
        {
          query: 'Maverik Flagstaff',
          lat: 35.1983,
          lng: -111.6513,
          radius_miles: 100,
        },
        context
      );

      expect(capturedUrl).toBe('https://places.googleapis.com/v1/places:searchText');
      const headers = capturedHeaders as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['X-Goog-Api-Key']).toBe('test-google-key-456');
      expect(headers['X-Goog-FieldMask']).toBe(
        'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.regularOpeningHours'
      );

      // Verify locationBias radius was clamped to exactly 50,000 meters
      const bias = capturedBody?.locationBias as { circle: { center: { latitude: number; longitude: number }; radius: number } };
      expect(bias).toBeDefined();
      expect(bias.circle.radius).toBe(50000);
      expect(bias.circle.center.latitude).toBe(35.1983);
      expect(bias.circle.center.longitude).toBe(-111.6513);

      // Verify cleaned place name and valid Place ID
      expect(res.places).toHaveLength(1);
      const place = res.places[0];
      expect(place.place_name).toBe('Maverik'); // Parens stripped
      expect(place.display_name).toBe('Maverik (West Main St)');
      expect(place.google_place_id).toBe('ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q');

      // Verify grounding cache was populated
      expect(groundingCache.resolvedPlaces).toHaveLength(1);
      expect(groundingCache.knownPlaceIds.has('ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q')).toBe(true);
    });

    it('strips fake/invalid Google Place IDs and does not add them to knownPlaceIds', async () => {
      const mockFetch: typeof fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            places: [
              {
                id: 'ChIJ_invalid_fake_id_12345', // Fails binary protobuf structural check
                displayName: { text: 'Mystery Diner' },
                formattedAddress: '404 Lost Hwy, Nowhere, AZ',
                location: { latitude: 35.0, longitude: -111.0 },
              },
            ],
          }),
          { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }
        );
      });

      const toolLib = new ScoutToolLibrary({
        googlePlacesApiKey: 'test-key',
        fetchImpl: mockFetch,
      });

      const groundingCache = createTurnGroundingCache();
      const context: ScoutToolExecutionContext = {
        tripContext: sampleTripContext,
        groundingCache,
      };

      const res = await toolLib.resolveAndStandardizePlace({ query: 'Mystery Diner' }, context);
      expect(res.places[0].google_place_id).toBeUndefined();
      expect(groundingCache.knownPlaceIds.has('ChIJ_invalid_fake_id_12345')).toBe(false);
    });

    it('fails loudly without silent fallback or mock places on HTTP 403 or 500', async () => {
      const mockFetch403: typeof fetch = vi.fn(async () => {
        return new Response('Forbidden: API key expired', { status: 403 });
      });

      const toolLib = new ScoutToolLibrary({
        googlePlacesApiKey: 'expired-key',
        fetchImpl: mockFetch403,
      });
      const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

      await expect(
        toolLib.resolveAndStandardizePlace({ query: 'Sedona Cafe' }, context)
      ).rejects.toThrow('Google Places API failed with HTTP 403');
    });
  });

  // =========================================================================
  // 5. Domain Grounding Tools
  // =========================================================================
  describe('5. Domain Grounding Tools', () => {
    describe('snap_to_highway_corridor', () => {
      it('preserves literal comma in OSRM URL and matches road name against candidates', async () => {
        let requestedUrl = '';
        const mockFetch: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
          requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          return new Response(
            JSON.stringify({
              code: 'Ok',
              waypoints: [
                {
                  name: 'Frontage Road',
                  location: [-111.767, 34.801],
                  distance: 12,
                },
                {
                  name: 'US Highway 89',
                  location: [-111.7667, 34.8005],
                  distance: 25,
                },
              ],
            }),
            { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }
          );
        });

        const toolLib = new ScoutToolLibrary({ fetchImpl: mockFetch });
        const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

        const result = await toolLib.snapToHighwayCorridor(
          { lat: 34.8005, lng: -111.7667, road_name: 'US-89' },
          context
        );

        // Verify URL contains literal unencoded comma
        expect(requestedUrl).toContain('/-111.7667,34.8005?number=5');
        expect(requestedUrl).not.toContain('%2C');
        expect(requestedUrl).not.toContain('%2c');

        // Verify highway token matching ("US-89" matches "US Highway 89")
        expect(result.road_name_matched).toBe(true);
        expect(result.snapped_road_name).toBe('US Highway 89');
        expect(result.snapped_lat).toBe(34.8005);
        expect(result.snapped_lng).toBe(-111.7667);
      });

      it('falls back to closest candidate with road_name_matched: false when unmatched', async () => {
        const mockFetch: typeof fetch = vi.fn(async () => {
          return new Response(
            JSON.stringify({
              code: 'Ok',
              waypoints: [
                {
                  name: 'AZ-179',
                  location: [-111.7667, 34.8005],
                  distance: 5,
                },
              ],
            }),
            { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }
          );
        });

        const toolLib = new ScoutToolLibrary({ fetchImpl: mockFetch });
        const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

        const result = await toolLib.snapToHighwayCorridor(
          { lat: 34.8005, lng: -111.7667, road_name: 'I-10' },
          context
        );

        expect(result.road_name_matched).toBe(false);
        expect(result.snapped_road_name).toBe('AZ-179');
      });

      it('fails loudly when OSRM returns HTTP 500 or non-Ok status', async () => {
        const mockFetch: typeof fetch = vi.fn(async () => {
          return new Response('Server Error', { status: 500 });
        });

        const toolLib = new ScoutToolLibrary({ fetchImpl: mockFetch });
        const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

        await expect(
          toolLib.snapToHighwayCorridor({ lat: 34.8005, lng: -111.7667 }, context)
        ).rejects.toThrow('OSRM nearest failed with HTTP 500');
      });
    });

    describe('calculate_detour_impact', () => {
      it('runs baseline and detour routes in parallel and calculates added miles and minutes', async () => {
        const routeCalls: string[] = [];
        const mockRouteService = {
          getRoute: vi.fn(async (coords: string) => {
            routeCalls.push(coords);
            const pairs = coords.split(';');
            if (pairs.length === 2) {
              // Baseline leg (Bell Rock -> Sedona Cafe): 5.0 mi, 8.0 min
              return { distanceMiles: 5.0, durationMinutes: 8.0 };
            } else {
              // Detour leg (Bell Rock -> Red Rock Overlook -> Sedona Cafe): 8.5 mi, 14.5 min
              return { distanceMiles: 8.5, durationMinutes: 14.5 };
            }
          }),
        } as unknown as RouteService;

        const toolLib = new ScoutToolLibrary({ routeService: mockRouteService });
        const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

        const res = await toolLib.calculateDetourImpact(
          {
            candidate_lat: 34.82,
            candidate_lng: -111.78,
            after_waypoint_id: 'wp_bell_rock',
          },
          context
        );

        expect(routeCalls).toHaveLength(2);
        expect(res.baseline_leg_miles).toBe(5.0);
        expect(res.baseline_leg_minutes).toBe(8.0);
        expect(res.detour_leg_miles).toBe(8.5);
        expect(res.detour_leg_minutes).toBe(14.5);
        expect(res.added_distance_miles).toBe(3.5);
        expect(res.added_duration_minutes).toBe(6.5);
      });

      it('handles appending candidate after the final stop', async () => {
        const mockRouteService = {
          getRoute: vi.fn(async () => {
            return { distanceMiles: 12.0, durationMinutes: 18.0 };
          }),
        } as unknown as RouteService;

        const toolLib = new ScoutToolLibrary({ routeService: mockRouteService });
        const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

        const res = await toolLib.calculateDetourImpact(
          {
            candidate_lat: 35.3,
            candidate_lng: -111.6,
            after_waypoint_id: 'wp_dest', // Final stop in sampleTripContext
          },
          context
        );

        expect(res.baseline_leg_miles).toBe(0);
        expect(res.baseline_leg_minutes).toBe(0);
        expect(res.added_distance_miles).toBe(12.0);
        expect(res.added_duration_minutes).toBe(18.0);
      });

      it('throws descriptive error listing available waypoint IDs when after_waypoint_id is unknown', async () => {
        const toolLib = new ScoutToolLibrary();
        const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

        await expect(
          toolLib.calculateDetourImpact(
            { candidate_lat: 34.0, candidate_lng: -111.0, after_waypoint_id: 'wp_nonexistent' },
            context
          )
        ).rejects.toThrow(
          'Waypoint "wp_nonexistent" not found in active trip context. Available IDs: wp_origin, wp_bell_rock, wp_sedona_lunch, wp_dest'
        );
      });
    });

    describe('simulate_schedule_cascade', () => {
      it('simulates forward schedule cascade for action "add"', async () => {
        const toolLib = new ScoutToolLibrary();
        const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

        const res = await toolLib.simulateScheduleCascade(
          {
            action: 'add',
            target_waypoint_id: 'wp_bell_rock',
            candidate_name: 'Chapel of the Holy Cross',
            candidate_type: 'scenic_pull_off',
            candidate_lat: 34.832,
            candidate_lng: -111.766,
            dwell_minutes: 25,
          },
          context
        );

        expect(res.action).toBe('add');
        expect(res.target_waypoint_id).toBe('wp_bell_rock');
        expect(res.stops).toHaveLength(5); // 4 original + 1 added
        const added = res.stops.find((s) => s.name === 'Chapel of the Holy Cross');
        expect(added).toBeDefined();
        expect(added?.dwell_minutes).toBe(25);
        expect(res.total_dwell_minutes).toBe(70); // 45 (lunch) + 25 (added)
      });

      it('simulates action "update" preserving untouched leg drive durations', async () => {
        const toolLib = new ScoutToolLibrary();
        const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

        // Updating Sedona Lunch dwell from 45m to 60m
        const res = await toolLib.simulateScheduleCascade(
          {
            action: 'update',
            target_waypoint_id: 'wp_sedona_lunch',
            dwell_minutes: 60,
          },
          context
        );

        expect(res.action).toBe('update');
        const lunchStop = res.stops.find((s) => s.id === 'wp_sedona_lunch');
        expect(lunchStop?.dwell_minutes).toBe(60);

        // Untouched leg duration from bell rock to lunch was preserved
        expect(lunchStop?.drive_minutes_from_previous).toBe(10);
      });

      it('simulates action "delete" removing the target waypoint', async () => {
        const toolLib = new ScoutToolLibrary();
        const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

        const res = await toolLib.simulateScheduleCascade(
          {
            action: 'delete',
            target_waypoint_id: 'wp_sedona_lunch',
          },
          context
        );

        expect(res.action).toBe('delete');
        expect(res.stops).toHaveLength(3);
        expect(res.stops.some((s) => s.id === 'wp_sedona_lunch')).toBe(false);
      });

      it('generates sunset warnings when stops arrive at or after 18:30 local time', async () => {
        const lateTripContext: ScoutTripContext = {
          ...sampleTripContext,
          departureTime: '17:00:00', // Departing at 5 PM, so later stops arrive after 18:30
        };

        const toolLib = new ScoutToolLibrary();
        const context: ScoutToolExecutionContext = { tripContext: lateTripContext };

        const res = await toolLib.simulateScheduleCascade(
          {
            action: 'update',
            target_waypoint_id: 'wp_bell_rock',
            dwell_minutes: 0,
          },
          context
        );

        expect(res.sunset_warnings.length).toBeGreaterThan(0);
        for (const warn of res.sunset_warnings) {
          const [h, m] = warn.arrival_time.split(':').map((n) => parseInt(n, 10));
          expect(h > 18 || (h === 18 && m >= 30)).toBe(true);
        }
      });
    });

    describe('audit_corridor_waypoints', () => {
      it('flags all structural and corridor anomalies concurrently', async () => {
        const mockFetch: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
          const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          // Return > 75m for the drive-by point to trigger off_highway_drive_by
          if (urlStr.includes('-111.7667,34.8005')) {
            return new Response(
              JSON.stringify({
                code: 'Ok',
                waypoints: [{ name: 'Service Track', location: [-111.7667, 34.8005], distance: 150 }],
              }),
              { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }
            );
          }
          return new Response(
            JSON.stringify({
              code: 'Ok',
              waypoints: [{ name: 'AZ-179', location: [-111.761, 34.8697], distance: 10 }],
            }),
            { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }
          );
        });

        const problematicWaypoints = [
          // 1. Off-highway drive-by (> 75m)
          {
            id: 'wp_driveby_off',
            name: 'Scenic Overlook',
            type: 'scenic_drive_by',
            lat: 34.8005,
            lng: -111.7667,
            dwell_minutes: 0,
          },
          // 2. Low leg speed anomaly (< 30 mph over >= 2 miles)
          {
            id: 'wp_slow_dirt',
            name: 'Canyon Viewpoint',
            type: 'scenic_pull_off',
            lat: 34.85,
            lng: -111.75,
            drive_distance_miles: 4.5,
            drive_speed_mph: 18,
          },
          // 3. Invalid Google Place ID
          {
            id: 'wp_fake_id',
            name: 'Local Diner',
            type: 'meal',
            lat: 34.86,
            lng: -111.76,
            google_place_id: 'ChIJ_not_protobuf_valid',
            address: '123 Main St',
            place_name: 'Local Diner',
          },
          // 4. Missing physical stop metadata
          {
            id: 'wp_missing_meta',
            name: 'Fuel Oasis',
            type: 'fuel',
            lat: 34.87,
            lng: -111.77,
            // missing address and place_name
          },
          // 5. Invalid route anchor on physical stop
          {
            id: 'wp_physical_anchor',
            name: 'Sedona Resort',
            type: 'lodging',
            lat: 34.88,
            lng: -111.78,
            address: '500 Resort Way',
            place_name: 'Sedona Resort',
            is_route_anchor: true, // Forbidden on physical stops
          },
          // 6. Non-anticipatory speech
          {
            id: 'wp_past_speech',
            name: 'Highway Transition',
            type: 'scenic_drive_by',
            lat: 34.89,
            lng: -111.79,
            notification: {
              title: 'Canyon View',
              message: 'Canyon view ahead.',
              speech: 'Now cruising along the red rock cliffs on your right.',
            },
          },
          // 7. Category notification mismatch
          {
            id: 'wp_fuel_stop_meal_type',
            name: 'Gas & Convenience',
            type: 'meal', // Type is meal but id refers to fuel
            lat: 34.9,
            lng: -111.8,
            address: '777 Hwy 89',
            place_name: 'Gas Stop',
          },
        ];

        const auditContext: ScoutToolExecutionContext = {
          tripContext: {
            ...sampleTripContext,
            waypoints: problematicWaypoints,
          },
        };

        const toolLib = new ScoutToolLibrary({ fetchImpl: mockFetch });
        const res = await toolLib.auditCorridorWaypoints({}, auditContext);

        expect(res.flagged_count).toBe(7);

        const issues1 = res.waypoints.find((w) => w.id === 'wp_driveby_off')?.issues;
        expect(issues1?.some((i) => i.includes('off_highway_drive_by'))).toBe(true);

        const issues2 = res.waypoints.find((w) => w.id === 'wp_slow_dirt')?.issues;
        expect(issues2?.some((i) => i.includes('low_leg_speed_anomaly'))).toBe(true);

        const issues3 = res.waypoints.find((w) => w.id === 'wp_fake_id')?.issues;
        expect(issues3?.some((i) => i.includes('invalid_google_place_id'))).toBe(true);

        const issues4 = res.waypoints.find((w) => w.id === 'wp_missing_meta')?.issues;
        expect(issues4?.some((i) => i.includes('missing_physical_stop_metadata'))).toBe(true);

        const issues5 = res.waypoints.find((w) => w.id === 'wp_physical_anchor')?.issues;
        expect(issues5?.some((i) => i.includes('invalid_route_anchor_on_physical_stop'))).toBe(true);

        const issues6 = res.waypoints.find((w) => w.id === 'wp_past_speech')?.issues;
        expect(issues6?.some((i) => i.includes('non_anticipatory_speech'))).toBe(true);

        const issues7 = res.waypoints.find((w) => w.id === 'wp_fuel_stop_meal_type')?.issues;
        expect(issues7?.some((i) => i.includes('category_notification_mismatch'))).toBe(true);
      });

      it('fails loudly when OSRM nearest returns HTTP 500 during audit', async () => {
        const mockFetch: typeof fetch = vi.fn(async () => {
          return new Response('OSRM Error', { status: 500 });
        });

        const toolLib = new ScoutToolLibrary({ fetchImpl: mockFetch });
        const context: ScoutToolExecutionContext = { tripContext: sampleTripContext };

        await expect(
          toolLib.auditCorridorWaypoints({}, context)
        ).rejects.toThrow('OSRM nearest failed with HTTP 500');
      });
    });
  });

  // =========================================================================
  // 6. Per-Turn Grounding Isolation, Suggestion Hydration & delete_waypoint
  // =========================================================================
  describe('6. Per-Turn Grounding Isolation, Suggestion Hydration & delete_waypoint', () => {
    it('parseScoutResponse deterministically hydrates suggestions with verified Places data', () => {
      const verifiedPlaces: ResolvedPlaceRecord[] = [
        {
          query: 'Maverik Flagstaff',
          place_name: 'Maverik',
          display_name: 'Maverik (West Route 66)',
          address: '1000 W Route 66, Flagstaff, AZ 86001',
          lat: 35.195,
          lng: -111.665,
          google_place_id: 'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q',
        },
        {
          query: 'Scenic Byway Overlook',
          place_name: 'Sedona Overlook',
          display_name: 'Sedona Scenic Overlook',
          address: 'AZ-179, Sedona, AZ',
          lat: 34.81,
          lng: -111.77,
          google_place_id: 'ChIJCR3fWhuQO4cRxCLXXbAfCxQ',
        },
      ];

      const rawAiResponse = `
        I recommend stopping at Maverik for fuel and checking the scenic overlook.
        \`\`\`json:suggestions
        [
          {
            "action": "add_waypoint",
            "name": "Maverik Fuel Stop",
            "type": "fuel",
            "lat": 35.19,
            "lng": -111.66,
            "reason": "Top rated highway fuel."
          },
          {
            "action": "add_waypoint",
            "name": "Sedona Overlook",
            "type": "scenic_drive_by",
            "lat": 34.8005,
            "lng": -111.7667,
            "is_route_anchor": true,
            "reason": "Highway scenic audio alert."
          }
        ]
        \`\`\`
      `;

      const parsed = parseScoutResponse(rawAiResponse, {
        resolvedPlaces: verifiedPlaces,
        knownPlaceIds: new Set(['ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q', 'ChIJCR3fWhuQO4cRxCLXXbAfCxQ']),
      });

      expect(parsed.suggestions).toHaveLength(2);

      // Physical stop (fuel): entrance coordinates hydrated from resolved place
      const fuelSug = parsed.suggestions[0];
      expect(fuelSug.place_name).toBe('Maverik');
      expect(fuelSug.address).toBe('1000 W Route 66, Flagstaff, AZ 86001');
      expect(fuelSug.google_place_id).toBe('ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q');
      expect(fuelSug.lat).toBe(35.195);
      expect(fuelSug.lng).toBe(-111.665);

      // Scenic drive-by with is_route_anchor: true: highway coordinates preserved!
      const scenicSug = parsed.suggestions[1];
      expect(scenicSug.place_name).toBe('Sedona Overlook');
      expect(scenicSug.lat).toBe(34.8005);
      expect(scenicSug.lng).toBe(-111.7667);
      expect(scenicSug.is_route_anchor).toBe(true);
    });

    it('parseScoutResponse parses delete_waypoint and backfills metadata from tripWaypoints', () => {
      const rawAiResponse = `
        Let's remove the redundant stop.
        \`\`\`json:suggestions
        [
          {
            "action": "delete_waypoint",
            "targetWaypointId": "wp_sedona_lunch",
            "reason": "Replacing lunch with picnic at overlook."
          }
        ]
        \`\`\`
      `;

      const parsed = parseScoutResponse(rawAiResponse, {
        tripWaypoints: sampleTripContext.waypoints,
      });

      expect(parsed.suggestions).toHaveLength(1);
      const delSug = parsed.suggestions[0];
      expect(delSug.action).toBe('delete_waypoint');
      expect(delSug.targetWaypointId).toBe('wp_sedona_lunch');
      expect(delSug.name).toBe('Sedona Cafe'); // Backfilled from sampleTripContext
      expect(delSug.type).toBe('meal');
      expect(delSug.lat).toBe(34.8697);
      expect(delSug.lng).toBe(-111.761);
      expect(delSug.reason).toBe('Replacing lunch with picnic at overlook.');
    });

    it('guarantees per-turn grounding isolation between concurrent chatStream requests', async () => {
      const placeRecordA: ResolvedPlaceRecord = {
        query: 'Stop A',
        place_name: 'Diner Alpha',
        display_name: 'Diner Alpha',
        address: '100 Alpha St',
        lat: 35.1,
        lng: -111.1,
        google_place_id: 'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q',
      };

      const placeRecordB: ResolvedPlaceRecord = {
        query: 'Stop B',
        place_name: 'Diner Beta',
        display_name: 'Diner Beta',
        address: '200 Beta St',
        lat: 34.2,
        lng: -112.2,
        google_place_id: 'ChIJCR3fWhuQO4cRxCLXXbAfCxQ',
      };

      // Mock AI Adapter that invokes the turnDispatcher during generation
      const mockAdapter: AiHarnessAdapter = {
        id: 'bedrock',
        name: 'Amazon Bedrock',
        defaultScoutModelId: 'us.moonshotai.kimi-k3',
        defaultCopywriterModelId: 'us.amazon.nova-2-lite-v1:0',
        isAvailable: vi.fn().mockResolvedValue(true),
        getAvailableModels: vi.fn().mockResolvedValue([]),
        getModelCatalog: vi.fn().mockReturnValue({
          models: [{ id: 'us.moonshotai.kimi-k3', name: 'Kimi K3', role: 'both', provider: 'Moonshot AI' }],
          defaultScoutModelId: 'us.moonshotai.kimi-k3',
          defaultCopywriterModelId: 'us.amazon.nova-2-lite-v1:0',
        }),
        validateModelId: vi.fn().mockResolvedValue('us.moonshotai.kimi-k3'),
        resolveModelId: vi.fn().mockResolvedValue('us.moonshotai.kimi-k3'),
        decorateScoutPrompt: (p: string) => p,
        sanitizeResponse: (t: string) => t,
        generate: vi.fn(),
        generateStreamWithTools: vi.fn(async (prompt, _tools, dispatcher) => {
          if (prompt.includes('Request A')) {
            // Request A resolves Diner Alpha
            await dispatcher?.('resolve_and_standardize_place', { query: 'Diner Alpha' });
            return {
              text: 'Here is stop A:\n```json:suggestions\n[{"action":"add_waypoint","name":"Diner Alpha","type":"meal","lat":35.0,"lng":-111.0}]\n```',
              inputTokens: 10,
              outputTokens: 20,
            };
          } else {
            // Request B resolves Diner Beta
            await dispatcher?.('resolve_and_standardize_place', { query: 'Diner Beta' });
            return {
              text: 'Here is stop B:\n```json:suggestions\n[{"action":"add_waypoint","name":"Diner Beta","type":"meal","lat":34.0,"lng":-112.0}]\n```',
              inputTokens: 10,
              outputTokens: 20,
            };
          }
        }),
      };

      const customDispatcher = vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === 'resolve_and_standardize_place') {
          const q = args.query as string;
          if (q.includes('Alpha')) {
            return { query: q, places: [placeRecordA], best_match: placeRecordA };
          } else {
            return { query: q, places: [placeRecordB], best_match: placeRecordB };
          }
        }
        return {};
      });

      const aiService = new AiService({ adapters: [mockAdapter], primaryAdapterId: 'bedrock' });
      const scoutService = new ScoutService({
        aiService,
        toolDispatcher: customDispatcher,
      });

      const reqA: ScoutChatRequest = {
        scope: { type: 'day', dayNumber: 1 },
        messages: [{ role: 'user', content: 'Request A for lunch' }],
        tripContext: sampleTripContext,
      };

      const reqB: ScoutChatRequest = {
        scope: { type: 'day', dayNumber: 1 },
        messages: [{ role: 'user', content: 'Request B for lunch' }],
        tripContext: sampleTripContext,
      };

      // Run concurrently
      const [resA, resB] = await Promise.all([
        scoutService.chatStream(reqA, () => {}),
        scoutService.chatStream(reqB, () => {}),
      ]);

      // Turn A suggestions are strictly hydrated from placeRecordA
      expect(resA.suggestions[0].place_name).toBe('Diner Alpha');
      expect(resA.suggestions[0].address).toBe('100 Alpha St');
      expect(resA.suggestions[0].google_place_id).toBe('ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q');

      // Turn B suggestions are strictly hydrated from placeRecordB
      expect(resB.suggestions[0].place_name).toBe('Diner Beta');
      expect(resB.suggestions[0].address).toBe('200 Beta St');
      expect(resB.suggestions[0].google_place_id).toBe('ChIJCR3fWhuQO4cRxCLXXbAfCxQ');
    });

    it('formatBedrockToolLabel formats active and done labels for all Route Scout tools', () => {
      // 1. search_web
      expect(formatBedrockToolLabel('search_web', { query: 'Sedona cafes' }, false)).toBe(
        'Searching web: "Sedona cafes"'
      );
      expect(formatBedrockToolLabel('search_web', { query: 'Sedona cafes' }, true)).toBe(
        'Searched web for "Sedona cafes"'
      );

      // 2. read_url_content
      expect(formatBedrockToolLabel('read_url_content', { url: 'https://example.com/guide' }, false)).toBe(
        'Reading content from example.com'
      );
      expect(formatBedrockToolLabel('read_url_content', { url: 'https://example.com/guide' }, true)).toBe(
        'Read content from example.com'
      );
      expect(formatBedrockToolLabel('read_url_content', {}, false)).toBe('Reading web content...');
      expect(formatBedrockToolLabel('read_url_content', {}, true)).toBe('Completed reading web content');

      // 3. resolve_and_standardize_place
      expect(formatBedrockToolLabel('resolve_and_standardize_place', { query: 'Maverik' }, false)).toBe(
        'Verifying place: "Maverik"'
      );
      expect(formatBedrockToolLabel('resolve_and_standardize_place', { query: 'Maverik' }, true)).toBe(
        'Verified place "Maverik"'
      );
      expect(formatBedrockToolLabel('resolve_and_standardize_place', {}, false)).toBe(
        'Verifying place details...'
      );
      expect(formatBedrockToolLabel('resolve_and_standardize_place', {}, true)).toBe(
        'Verified place details'
      );

      // 4. snap_to_highway_corridor
      expect(formatBedrockToolLabel('snap_to_highway_corridor', { road_name: 'US-89' }, false)).toBe(
        'Snapping coordinate to US-89...'
      );
      expect(formatBedrockToolLabel('snap_to_highway_corridor', { road_name: 'US-89' }, true)).toBe(
        'Snapped coordinate to US-89'
      );

      // 5. calculate_detour_impact
      expect(formatBedrockToolLabel('calculate_detour_impact', {}, false)).toBe(
        'Calculating detour driving impact...'
      );
      expect(formatBedrockToolLabel('calculate_detour_impact', {}, true)).toBe(
        'Calculated detour driving impact'
      );

      // 6. simulate_schedule_cascade
      expect(formatBedrockToolLabel('simulate_schedule_cascade', {}, false)).toBe(
        'Simulating schedule cascade...'
      );
      expect(formatBedrockToolLabel('simulate_schedule_cascade', {}, true)).toBe(
        'Simulated schedule cascade'
      );

      // 7. audit_corridor_waypoints
      expect(formatBedrockToolLabel('audit_corridor_waypoints', {}, false)).toBe(
        'Auditing corridor waypoints...'
      );
      expect(formatBedrockToolLabel('audit_corridor_waypoints', {}, true)).toBe(
        'Audited corridor waypoints'
      );

      // Fallback
      expect(formatBedrockToolLabel('custom_unknown_tool', {}, false)).toBe('Running custom unknown tool...');
      expect(formatBedrockToolLabel('custom_unknown_tool', {}, true)).toBe('Completed custom unknown tool');
    });

    it('RouteScoutDrawer renders delete_waypoint suggestion card and removes waypoint upon click', async () => {
      const onDeleteWaypoint = vi.fn();

      // Configure mock chatWithScoutStream to return a delete_waypoint suggestion
      (chatWithScoutStream as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        async (_req: ScoutChatRequest, onEvent: (ev: ScoutStreamEvent) => void) => {
          onEvent({
            event: 'suggestions',
            data: {
              suggestions: [
                {
                  id: 'sug_del_1',
                  action: 'delete_waypoint',
                  name: 'Sedona Cafe',
                  type: 'meal',
                  lat: 34.8697,
                  lng: -111.761,
                  targetWaypointId: 'wp_sedona_lunch',
                  reason: 'Redundant lunch stop.',
                },
              ],
            },
          });
          onEvent({
            event: 'done',
            data: {
              reply: 'I recommend removing Sedona Cafe from the itinerary.',
              suggestions: [
                {
                  id: 'sug_del_1',
                  action: 'delete_waypoint',
                  name: 'Sedona Cafe',
                  type: 'meal',
                  lat: 34.8697,
                  lng: -111.761,
                  targetWaypointId: 'wp_sedona_lunch',
                  reason: 'Redundant lunch stop.',
                },
              ],
              sessionId: 'scout_test_session',
              engine: 'bedrock',
              modelId: 'us.moonshotai.kimi-k3',
            },
          });
          return {
            reply: 'I recommend removing Sedona Cafe from the itinerary.',
            suggestions: [],
            sessionId: 'scout_test_session',
            engine: 'bedrock',
            modelId: 'us.moonshotai.kimi-k3',
          };
        }
      );

      let app!: ReactTestRenderer;
      await act(async () => {
        app = create(
          <RouteScoutDrawer
            isOpen={true}
            onClose={vi.fn()}
            trip={sampleParsedTrip}
            activeDayIndex={0}
            activeDay={sampleParsedTrip.days[0]}
            waypoints={sampleParsedTrip.days[0].waypoints}
            scope={{ type: 'day', dayNumber: 1 }}
            onChangeScope={vi.fn()}
            onAddWaypoint={vi.fn()}
            onUpdateWaypoint={vi.fn()}
            onDeleteWaypoint={onDeleteWaypoint}
            onPreviewCoordinate={vi.fn()}
            aiAvailable={true}
            aiModels={[{ id: 'us.moonshotai.kimi-k3', name: 'Kimi K3', role: 'both', provider: 'Moonshot AI' }]}
            selectedModelId="us.moonshotai.kimi-k3"
          />
        );
      });
      mounted.push(app);

      // Trigger user question to Route Scout
      const textarea = app.root.findByType('textarea');
      await act(async () => {
        textarea.props.onChange({ target: { value: 'Can we remove the lunch stop?' } });
      });

      const form = app.root.findByType('form');
      await act(async () => {
        form.props.onSubmit({ preventDefault: vi.fn() });
      });

      // Verify the delete_waypoint suggestion card rendered with 'Remove Stop' badge and button
      const allSpans = app.root.findAllByType('span');
      const badge = allSpans.find((s) => s.children.includes('Remove Stop'));
      expect(badge).toBeDefined();

      const allButtons = app.root.findAllByType('button');
      const removeButton = allButtons.find((b) => {
        const span = b.findAllByType('span');
        return span.some((s) => s.children.includes('Remove Stop'));
      });
      expect(removeButton).toBeDefined();
      expect(removeButton?.props.disabled).toBe(false);

      // Click 'Remove Stop'
      await act(async () => {
        removeButton?.props.onClick();
      });

      // Verify onDeleteWaypoint was invoked with targetWaypointId
      expect(onDeleteWaypoint).toHaveBeenCalledTimes(1);
      expect(onDeleteWaypoint).toHaveBeenCalledWith('wp_sedona_lunch');

      // Verify button transitioned to 'Removed ✓' and disabled
      const updatedButtons = app.root.findAllByType('button');
      const removedButton = updatedButtons.find((b) => {
        const span = b.findAllByType('span');
        return span.some((s) => s.children.includes('Removed ✓'));
      });
      expect(removedButton).toBeDefined();
      expect(removedButton?.props.disabled).toBe(true);
    });
  });

  // =========================================================================
  // 7. Adversarial Hardening & Edge Cases (Gate 2B)
  // =========================================================================
  describe('7. Adversarial Hardening & Edge Cases (Gate 2B)', () => {
    it('blocks trailing-dot FQDNs, wildcard DNS rebinding domains, forbidden ports, and NAT64/Teredo/hex IPv6 literals', () => {
      // Trailing-dot internal hostnames (F-01)
      expect(() => assertSafeExternalUrl('http://localhost./api')).toThrow(/forbidden internal hostname/);
      expect(() => assertSafeExternalUrl('http://metadata.google.internal./computeMetadata')).toThrow(
        /forbidden internal hostname/
      );
      expect(() => assertSafeExternalUrl('http://admin.local./')).toThrow(/forbidden internal hostname/);

      // Wildcard DNS rebinding domains (F-16)
      expect(() => assertSafeExternalUrl('http://127.0.0.1.nip.io/')).toThrow(/forbidden internal hostname/);
      expect(() => assertSafeExternalUrl('http://169.254.169.254.sslip.io/')).toThrow(
        /forbidden internal hostname/
      );

      // Forbidden ports (F-03)
      expect(() => assertSafeExternalUrl('https://example.com:22/')).toThrow(/port "22" is not allowed/);
      expect(() => assertSafeExternalUrl('http://example.com:6379/')).toThrow(/port "6379" is not allowed/);

      // IPv6 hex-mapped, SIIT, NAT64, and Teredo addresses (F-02)
      expect(() => assertSafeExternalUrl('http://[::ffff:7f00:1]/')).toThrow(/private.*IPv4/i);
      expect(() => assertSafeExternalUrl('http://[::ffff:a9fe:a9fe]/')).toThrow(/private.*IPv4/i);
      expect(() => assertSafeExternalUrl('http://[::ffff:0:7f00:1]/')).toThrow(/private.*IPv4/i);
      expect(() => assertSafeExternalUrl('http://[64:ff9b::7f00:1]/')).toThrow(/NAT64/);
      expect(() => assertSafeExternalUrl('http://[64:ff9b:1::a9fe:a9fe]/')).toThrow(/NAT64/);
      expect(() => assertSafeExternalUrl('http://[2001:0000:4136:e378:8000:63bf:3fff:fdd2]/')).toThrow(
        /Teredo/
      );
    });

    it('blocks DNS rebinding to loopback or IMDS via dnsLookup on initial request and redirect hops', async () => {
      const rebindingDns = vi.fn().mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
      await expect(
        assertSafeExternalUrlWithDns('https://evil.example.com/latest/meta-data', rebindingDns)
      ).rejects.toThrow(/private or reserved IPv4/);

      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://rebind-hop.example.com/secret' },
        })
      );

      const hopDns = vi
        .fn()
        .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
        .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);

      const toolLib = new ScoutToolLibrary({ fetchImpl: mockFetch, dnsLookup: hopDns });
      await expect(
        toolLib.readUrlContent({ url: 'https://safe-first.example.com/start' }, { tripContext: sampleTripContext })
      ).rejects.toThrow(/private or reserved IPv4/);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('htmlToReadableText is linear-time on 512 KB of unclosed <script> tags and avoids double-decoding &amp;lt;', () => {
      // 1. ReDoS linear time check (F-04)
      const maliciousHtml = '<html><head><title>Safe Title</title></head><body>' + '<script>var x = 1;'.repeat(30_000);
      const t0 = Date.now();
      const parsed = htmlToReadableText(maliciousHtml);
      const elapsedMs = Date.now() - t0;

      expect(elapsedMs).toBeLessThan(500);
      expect(parsed.title).toBe('Safe Title');
      expect(parsed.text).toBe('Safe Title');

      // 2. Single-pass entity decoding check (F-12)
      const encodedHtml = '<p>Literal tag: &amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;</p>';
      const decoded = htmlToReadableText(encodedHtml);
      expect(decoded.text).toBe('Literal tag: &lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('read_url_content caps streamed body at 512 KiB, cancels reader, and decodes split UTF-8 multi-byte chars', async () => {
      let cancelCalled = false;
      // Split 4-byte emoji 🌵 (0xF0, 0x9F, 0x8C, 0xB5) across two chunks, followed by unending 300 KiB chunks
      const chunk1 = new Uint8Array([0x3c, 0x70, 0x3e, 0xf0, 0x9f]); // "<p>" + first 2 bytes of 🌵
      const chunk2 = new Uint8Array([0x8c, 0xb5, 0x20, ...new Uint8Array(600 * 1024).fill(0x41)]); // last 2 bytes of 🌵 + " " + 600KB of 'A'
      let step = 0;

      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (step === 0) {
            step++;
            controller.enqueue(chunk1);
          } else {
            step++;
            controller.enqueue(chunk2);
          }
        },
        cancel() {
          cancelCalled = true;
        },
      });

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      );

      const toolLib = new ScoutToolLibrary({ fetchImpl: mockFetch, maxUrlChars: 100 });
      const res = await toolLib.readUrlContent(
        { url: 'https://parks.example.com/cactus' },
        { tripContext: sampleTripContext }
      );

      expect(cancelCalled).toBe(true);
      expect(res.truncated).toBe(true);
      expect(res.content.startsWith('🌵 A')).toBe(true);
      expect(res.content.length).toBe(100);
    });

    it('isolates shared SSM loadPromise from individual caller abort so concurrent caller succeeds without cooldown', async () => {
      delete process.env.BRAVE_SEARCH_API_KEY;
      let resolveSsm!: (value: unknown) => void;
      const ssmSend = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSsm = resolve;
          })
      );
      const mockSsmClient = { send: ssmSend } as unknown as SSMClient;
      const toolLib = new ScoutToolLibrary({ ssmClient: mockSsmClient });

      const callerAAbort = new AbortController();
      const callerBAbort = new AbortController();

      const pA = toolLib.resolveBraveSearchApiKey(callerAAbort.signal);
      const pB = toolLib.resolveBraveSearchApiKey(callerBAbort.signal);

      // Caller A aborts while SSM request is in flight
      callerAAbort.abort();
      await expect(pA).rejects.toThrow('Request aborted');

      // SSM finishes and resolves key for Caller B
      resolveSsm({
        Parameters: [{ Name: '/roadtrip-copilot/brave-search-api-key', Value: 'ssm-shared-brave-key' }],
      });

      await expect(pB).resolves.toBe('ssm-shared-brave-key');
      expect(ssmSend).toHaveBeenCalledTimes(1);
    });

    it('resolve_and_standardize_place rejects partial or out-of-range coordinates and filters groundingCache to query matches', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            places: [
              {
                id: 'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q',
                displayName: { text: 'Maverik Adventure Stop' },
                formattedAddress: '1000 W Route 66, Flagstaff, AZ',
                location: { latitude: 35.195, longitude: -111.665 },
              },
              {
                id: 'ChIJCR3fWhuQO4cRxCLXXbAfCxQ',
                displayName: { text: 'Unrelated Tire Shop' },
                formattedAddress: '1002 W Route 66, Flagstaff, AZ',
                location: { latitude: 35.1952, longitude: -111.6652 },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

      const toolLib = new ScoutToolLibrary({
        googlePlacesApiKey: 'test-places-key',
        fetchImpl: mockFetch,
      });
      const cache = createTurnGroundingCache();

      // Reject partial lat without lng (F-13)
      await expect(
        toolLib.resolveAndStandardizePlace(
          { query: 'Maverik', lat: 35.195 },
          { tripContext: sampleTripContext, groundingCache: cache }
        )
      ).rejects.toThrow(/both "lat" and "lng" must be provided together/i);

      // Reject negative radius_miles (F-14)
      await expect(
        toolLib.resolveAndStandardizePlace(
          { query: 'Maverik', lat: 35.195, lng: -111.665, radius_miles: -5 },
          { tripContext: sampleTripContext, groundingCache: cache }
        )
      ).rejects.toThrow(/Invalid radius_miles/);

      // Valid call: caches best_match + query-matching places, excluding unrelated distractor from groundingCache (F-15)
      await toolLib.resolveAndStandardizePlace(
        { query: 'Maverik', lat: 35.195, lng: -111.665 },
        { tripContext: sampleTripContext, groundingCache: cache }
      );
      expect(cache.resolvedPlaces).toHaveLength(1);
      expect(cache.resolvedPlaces[0].place_name).toBe('Maverik Adventure Stop');
    });

    it('snap_to_highway_corridor distinguishes US-89 from I-89 and State Route 89', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'Ok',
            waypoints: [
              { name: 'Interstate 89', distance: 10, location: [-111.65, 35.2] },
              { name: 'US Highway 89', distance: 25, location: [-111.66, 35.21] },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

      const toolLib = new ScoutToolLibrary({ fetchImpl: mockFetch });
      const res = await toolLib.snapToHighwayCorridor(
        { lat: 35.2, lng: -111.65, road_name: 'US-89' },
        { tripContext: sampleTripContext }
      );

      expect(res.road_name_matched).toBe(true);
      expect(res.snapped_road_name).toBe('US Highway 89');
      expect(res.snapped_lat).toBe(35.21);
    });

    it('audit_corridor_waypoints does not false-positive match "gas" inside "Las Vegas"', async () => {
      const mockFetch = vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              code: 'Ok',
              waypoints: [{ name: 'I-15', distance: 5, location: [-115.1398, 36.1699] }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      );

      const toolLib = new ScoutToolLibrary({ fetchImpl: mockFetch });
      const vegasContext: ScoutTripContext = {
        tripName: 'Vegas Trip',
        waypoints: [
          {
            id: 'wp_vegas_lunch',
            name: 'Las Vegas Bistro',
            place_name: 'Las Vegas Bistro',
            address: '100 Las Vegas Blvd, Las Vegas, NV',
            type: 'meal',
            lat: 36.1699,
            lng: -115.1398,
            dwell_minutes: 45,
            notification: {
              title: 'Las Vegas Lunch',
              message: 'Stopping in Las Vegas for lunch.',
              speech: 'Approaching Las Vegas Bistro ahead in half a mile.',
            },
          },
          {
            id: 'wp_vegas_hotel',
            name: 'Las Vegas Resort',
            type: 'destination',
            lat: 36.1701,
            lng: -115.1399,
            dwell_minutes: 0,
          },
        ],
      };

      const res = await toolLib.auditCorridorWaypoints({}, { tripContext: vegasContext });
      expect(res.flagged_count).toBe(0);
    });

    it('hydrateSuggestionFromResolvedPlaces does not overwrite scenic_pull_off coordinates or cross-pollinate mismatched Place IDs', () => {
      const places: ResolvedPlaceRecord[] = [
        {
          query: 'Coffee Shop',
          place_name: 'Rim View Coffee',
          display_name: 'Rim View Coffee',
          address: '100 Rim Dr',
          lat: 34.8001,
          lng: -111.7661,
          google_place_id: 'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q',
        },
      ];

      // 1. A scenic_pull_off 0.05 miles away from a coffee shop must NOT be proximity-matched or moved (F-31)
      const scenicPullOff = hydrateSuggestionFromResolvedPlaces(
        {
          id: 'sug_1',
          action: 'add_waypoint',
          name: 'Canyon Rim Overlook',
          type: 'scenic_pull_off',
          lat: 34.8005,
          lng: -111.7665,
          dwell_minutes: 15,
          reason: 'Scenic canyon vista.',
        },
        places,
        new Set(['ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q'])
      );
      expect(scenicPullOff.lat).toBe(34.8005);
      expect(scenicPullOff.lng).toBe(-111.7665);
      expect(scenicPullOff.google_place_id).toBeUndefined();

      // 2. A suggestion with an explicit Place ID must NOT be matched by name/proximity to a different Place ID (F-32)
      const explicitPlaceSug = hydrateSuggestionFromResolvedPlaces(
        {
          id: 'sug_2',
          action: 'add_waypoint',
          name: 'Rim View Coffee',
          type: 'meal',
          lat: 34.8002,
          lng: -111.7662,
          google_place_id: 'ChIJCR3fWhuQO4cRxCLXXbAfCxQ',
          reason: 'Different branch.',
        },
        places,
        new Set(['ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q', 'ChIJCR3fWhuQO4cRxCLXXbAfCxQ'])
      );
      expect(explicitPlaceSug.google_place_id).toBe('ChIJCR3fWhuQO4cRxCLXXbAfCxQ');
      expect(explicitPlaceSug.lat).toBe(34.8002);
      expect(explicitPlaceSug.address).toBeUndefined();
    });

    it('parseScoutResponse drops delete_waypoint with unknown ID and overrides spoofed name/type from tripWaypoints', () => {
      const rawOutput = `
        Removing stop.
        \`\`\`json:suggestions
        [
          {
            "action": "delete_waypoint",
            "targetWaypointId": "non_existent_id",
            "name": "Hallucinated Stop",
            "reason": "Does not exist."
          },
          {
            "action": "delete_waypoint",
            "targetWaypointId": "wp_sedona_lunch",
            "name": "Spoofed Harmless Stop Name",
            "type": "scenic_drive_by",
            "lat": 0,
            "lng": 0,
            "reason": "Actually deleting Sedona Cafe."
          }
        ]
        \`\`\`
      `;

      const parsed = parseScoutResponse(rawOutput, {
        tripWaypoints: sampleTripContext.waypoints,
      });

      // Unknown ID dropped; spoofed card uses true name/type/lat/lng from sampleTripContext.waypoints (F-34)
      expect(parsed.suggestions).toHaveLength(1);
      expect(parsed.suggestions[0].targetWaypointId).toBe('wp_sedona_lunch');
      expect(parsed.suggestions[0].name).toBe('Sedona Cafe');
      expect(parsed.suggestions[0].type).toBe('meal');
      expect(parsed.suggestions[0].lat).toBe(34.8697);
      expect(parsed.suggestions[0].lng).toBe(-111.761);
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
});
