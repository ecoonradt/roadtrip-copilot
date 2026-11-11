import http from 'node:http';
import https from 'node:https';
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';
import {
  SCOUT_TOOL_DECLARATIONS,
  cleanPlaceName,
  assertSafeExternalUrl,
  assertSafeExternalUrlWithDns,
  resolveValidatedUrlWithDns,
  parseHighwayDesignators,
  matchesHighwayRoadName,
  htmlToReadableText,
  ScoutToolLibrary,
  createTurnGroundingCache,
  type ResolvedPlaceRecord,
  type TurnGroundingCache,
  type ScoutToolExecutionContext,
} from './scoutTools.js';
import {
  ScoutService,
  parseScoutResponse,
  hydrateSuggestionFromResolvedPlaces,
  matchResolvedPlaceForSuggestion,
  isInTransitOrAnchorSuggestion,
  isValidGooglePlaceId,
} from './scoutService.js';
import { formatBedrockToolLabel, AwsBedrockHarnessAdapter } from '../ai/bedrock/bedrockService.js';
import { RouteService } from '../routeService.js';
import { AiService, type AiHarnessAdapter } from '../ai/aiService.js';
import type { ScoutTripContext, ScoutChatRequest, ScoutStreamEvent } from '../../types/scout.js';

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

describe('Route Scout URL safety policy, redirects, and response bounds', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
  });

  describe('2. SSRF & Redirect Hardening (assertSafeExternalUrl & read_url_content)', () => {
    it('allows valid HTTPS domains and public IPv6 addresses', () => {
      const parsed1 = assertSafeExternalUrl('https://example.com/guide');
      expect(parsed1.hostname).toBe('example.com');
      expect(parsed1.protocol).toBe('https:');

      const parsed2 = assertSafeExternalUrl('https://[2606:4700:4700::1]/dns-query');
      expect(parsed2.hostname).toBe('[2606:4700:4700::1]');
      expect(parsed2.protocol).toBe('https:');

      const parsed3 = assertSafeExternalUrl('http://roadtrip.guide/scenic-routes?state=az');
      expect(parsed3.hostname).toBe('roadtrip.guide');
      expect(parsed3.protocol).toBe('http:');
      expect(parsed3.port).toBe('');
    });

    it('enforces the approved external port policy (80/443 only)', () => {
      // Default HTTP/HTTPS ports normalize to '' and remain allowed.
      expect(assertSafeExternalUrl('http://example.com/guide').port).toBe('');
      expect(assertSafeExternalUrl('https://example.com/guide').port).toBe('');

      // Explicit default ports normalize to '' and remain allowed.
      const explicitHttp = assertSafeExternalUrl('http://example.com:80/guide');
      expect(explicitHttp.protocol).toBe('http:');
      expect(explicitHttp.port).toBe('');
      const explicitHttps = assertSafeExternalUrl('https://example.com:443/guide');
      expect(explicitHttps.protocol).toBe('https:');
      expect(explicitHttps.port).toBe('');

      const disallowedPortUrls: Array<{ url: string; port: string }> = [
        { url: 'http://example.com:8080/guide', port: '8080' },
        { url: 'https://example.com:8443/guide', port: '8443' },
        { url: 'http://example.com:8000/guide', port: '8000' },
        { url: 'https://example.com:3000/guide', port: '3000' },
        { url: 'http://example.com:22/guide', port: '22' },
        { url: 'https://example.com:6379/guide', port: '6379' },
      ];
      for (const { url, port } of disallowedPortUrls) {
        expect(() => assertSafeExternalUrl(url)).toThrow(new RegExp(`port "${port}" is not allowed`));
      }
    });

    it('rejects forbidden ports before DNS resolution or fetch', async () => {
      const dnsLookup = vi.fn(async (): Promise<Array<{ address: string; family: number }>> => [
        { address: '93.184.216.34', family: 4 },
      ]);
      const fetchImpl: typeof fetch = vi.fn(async () => new Response('must not be fetched'));
      const toolLib = new ScoutToolLibrary({ dnsLookup, fetchImpl });

      for (const url of ['http://example.com:8080/guide', 'https://example.com:8443/guide']) {
        await expect(
          toolLib.readUrlContent({ url }, { tripContext: sampleTripContext })
        ).rejects.toThrow(/port "\d+" is not allowed/);
      }

      expect(dnsLookup).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
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


    it('blocks trailing-dot FQDNs, wildcard DNS rebinding domains, forbidden ports, and NAT64/Teredo/hex IPv6 literals', () => {
      expect(() => assertSafeExternalUrl('http://localhost./api')).toThrow(/forbidden internal hostname/);
      expect(() => assertSafeExternalUrl('http://metadata.google.internal./computeMetadata')).toThrow(
        /forbidden internal hostname/
      );
      expect(() => assertSafeExternalUrl('http://admin.local./')).toThrow(/forbidden internal hostname/);

      expect(() => assertSafeExternalUrl('http://127.0.0.1.nip.io/')).toThrow(/forbidden internal hostname/);
      expect(() => assertSafeExternalUrl('http://169.254.169.254.sslip.io/')).toThrow(
        /forbidden internal hostname/
      );

      expect(() => assertSafeExternalUrl('https://example.com:22/')).toThrow(/port "22" is not allowed/);
      expect(() => assertSafeExternalUrl('http://example.com:6379/')).toThrow(/port "6379" is not allowed/);

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
    it('binds URL validation to actual connection, prevents DNS rebinding across redirect hops, preserves Host/SNI, and bounds DNS lookup', async () => {
      // 1A. Bounded DNS timeout and AbortSignal cancellation
      const hangingDns = vi.fn(() => new Promise<Array<{ address: string; family: number }>>(() => {}));
      await expect(
        resolveValidatedUrlWithDns('https://slow-dns.example.com/guide', hangingDns, { timeoutMs: 20 })
      ).rejects.toThrow('Request timed out after 20ms');

      const abortController = new AbortController();
      setTimeout(() => abortController.abort(), 10);
      await expect(
        resolveValidatedUrlWithDns('https://abort-dns.example.com/guide', hangingDns, {
          abortSignal: abortController.signal,
          timeoutMs: 2000,
        })
      ).rejects.toThrow('Request aborted');

      // 1B. Pinned transport prevents public-to-private DNS rebinding at connection time & preserves Host/SNI across redirect hops
      let dnsLookupCallCount = 0;
      const rebindingDns = vi.fn(async (host: string) => {
        dnsLookupCallCount++;
        if (host === 'hop1.example.com') {
          // If a second unpinned lookup were ever invoked for hop1, it would return 127.0.0.1!
          return dnsLookupCallCount === 1
            ? [{ address: '93.184.216.34', family: 4 }]
            : [{ address: '127.0.0.1', family: 4 }];
        }
        if (host === 'hop2.example.org') {
          return [{ address: '93.184.216.35', family: 4 }];
        }
        return [{ address: '127.0.0.1', family: 4 }];
      });

      const capturedRequests: Array<{
        hostname?: string;
        hostHeader?: string;
        servername?: string;
        resolvedAddress?: string;
        resolvedFamily?: number;
      }> = [];

      const httpsRequestSpy = vi.spyOn(https, 'request').mockImplementation(((
        options: https.RequestOptions,
        callback?: (res: http.IncomingMessage) => void
      ) => {
        let resolvedAddress: string | undefined;
        let resolvedFamily: number | undefined;
        if (typeof options.lookup === 'function') {
          options.lookup(
            options.hostname || '',
            { all: false },
            (_err, address, family) => {
              resolvedAddress = typeof address === 'string' ? address : undefined;
              resolvedFamily = family;
            }
          );
        }
        const headersObj = (options.headers || {}) as Record<string, string>;
        const reqRecord = {
          hostname: options.hostname ?? undefined,
          hostHeader: headersObj.Host || headersObj.host,
          servername: (options as { servername?: string }).servername,
          resolvedAddress,
          resolvedFamily,
        };
        capturedRequests.push(reqRecord);

        const reqStream = new PassThrough() as unknown as http.ClientRequest;
        reqStream.end = (() => {
          queueMicrotask(() => {
            const incomingStream = new PassThrough();
            const incoming = incomingStream as unknown as http.IncomingMessage;
            if (options.hostname === 'hop1.example.com') {
              incoming.statusCode = 302;
              incoming.statusMessage = 'Found';
              incoming.headers = { location: 'https://hop2.example.org/scenic-byway' };
              callback?.(incoming);
              incomingStream.end();
            } else {
              incoming.statusCode = 200;
              incoming.statusMessage = 'OK';
              incoming.headers = { 'content-type': 'text/html; charset=utf-8' };
              callback?.(incoming);
              incomingStream.end('<html><head><title>Pinned Scenic Guide</title></head><body><p>Red Rock Byway mileposts.</p></body></html>');
            }
          });
          return reqStream;
        }) as unknown as http.ClientRequest['end'];
        reqStream.destroy = (() => reqStream) as unknown as http.ClientRequest['destroy'];
        return reqStream;
      }) as unknown as typeof https.request);

      try {
        // Notice: No fetchImpl injected -> exercises pinned node:https transport!
        const toolLib = new ScoutToolLibrary({ dnsLookup: rebindingDns });
        const res = await toolLib.readUrlContent({ url: 'https://hop1.example.com/start' }, {} as ScoutToolExecutionContext);

        expect(res.url).toBe('https://hop2.example.org/scenic-byway');
        expect(res.title).toBe('Pinned Scenic Guide');
        expect(res.content).toContain('Red Rock Byway mileposts.');

        // DNS lookup called exactly once per hostname (never re-queried by transport)
        expect(rebindingDns).toHaveBeenCalledTimes(2);
        expect(capturedRequests).toHaveLength(2);
        expect(capturedRequests[0]).toEqual({
          hostname: 'hop1.example.com',
          hostHeader: 'hop1.example.com',
          servername: 'hop1.example.com',
          resolvedAddress: '93.184.216.34',
          resolvedFamily: 4,
        });
        expect(capturedRequests[1]).toEqual({
          hostname: 'hop2.example.org',
          hostHeader: 'hop2.example.org',
          servername: 'hop2.example.org',
          resolvedAddress: '93.184.216.35',
          resolvedFamily: 4,
        });
      } finally {
        httpsRequestSpy.mockRestore();
      }

      // 1C. Local loopback fixture server: if a socket or lookup ever rebounds to 127.0.0.1 at connect time, connection is aborted before reading loopback content
      const secretServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('LOOPBACK_SECRET_METADATA_PAYLOAD');
      });
      await new Promise<void>((resolve) => secretServer.listen(0, '127.0.0.1', () => resolve()));
      const addrInfo = secretServer.address();
      const port = typeof addrInfo === 'object' && addrInfo ? addrInfo.port : 80;

      try {
        const toolLib = new ScoutToolLibrary();
        const requestPinned = (
          toolLib as unknown as {
            requestPinnedUrl: (
              validated: { url: URL; addresses: Array<{ address: string; family: number }> },
              headers: Record<string, string>,
              signal: AbortSignal
            ) => Promise<Response>;
          }
        ).requestPinnedUrl.bind(toolLib);

        await expect(
          requestPinned(
            {
              url: new URL(`http://rebind.example.com:${port}/secret`),
              // Simulate a tampered/rebound loopback address reaching connection time
              addresses: [{ address: '127.0.0.1', family: 4 }],
            },
            { Accept: 'text/plain' },
            new AbortController().signal
          )
        ).rejects.toThrow(/Blocked URL: private or reserved IPv4 address "127\.0\.0\.1"/);
      } finally {
        await new Promise<void>((resolve) => secretServer.close(() => resolve()));
      }
    });
    it('extracts HTML in linear O(n) time on pathological repeated "<" and malformed generic tags while preserving formatting', () => {
      // 40,000 repeated '<' without '>' (previously caused ~1s quadratic backtracking)
      const repeatedLtHtml = `<title>Linear Title</title><p>Intro paragraph</p>${'<'.repeat(40_000)}`;
      const resRepeated = htmlToReadableText(repeatedLtHtml);
      expect(resRepeated.title).toBe('Linear Title');
      expect(resRepeated.text).toBe('Linear Title Intro paragraph');

      // Malformed generic tags without closing '>'
      const malformedGenericHtml =
        '<html><head><title>Canyon Guide</title><script>var secret = 1;</script></head>' +
        '<body><h1>Sedona Stops</h1><ul><li>Bell Rock</li><li>Cathedral Rock</li></ul>' +
        '<p>First line<br/>Second line &amp;lt;safe&gt;</p>' +
        '<div attr="unclosed'.repeat(5_000);
      const resMalformed = htmlToReadableText(malformedGenericHtml);
      expect(resMalformed.title).toBe('Canyon Guide');
      expect(resMalformed.text).not.toContain('var secret');
      expect(resMalformed.text).toContain('Sedona Stops');
      expect(resMalformed.text).toContain('* Bell Rock\n* Cathedral Rock');
      expect(resMalformed.text).toContain('First line\nSecond line &lt;safe>');
    });
    it('keeps timeout deadlines and AbortSignal active through full JSON/text body consumption and cancels stalled response bodies', async () => {
      // 6A. Fast headers (200 OK) followed by stalled JSON body times out at upstreamTimeoutMs and cancels body
      let bodyCancelledOnTimeout = false;
      const stalledBodyFetch: typeof fetch = vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"web":{"results":['));
            // Never closes -> stalls during res.json()
          },
          cancel() {
            bodyCancelledOnTimeout = true;
          },
        });
        return new Response(stream, {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      });

      const timeoutLib = new ScoutToolLibrary({
        braveSearchApiKey: 'test-key',
        fetchImpl: stalledBodyFetch,
        upstreamTimeoutMs: 25,
      });

      await expect(timeoutLib.searchWeb({ query: 'Sedona trails' }, {} as ScoutToolExecutionContext)).rejects.toThrow(
        /Upstream request timed out after 25ms/
      );
      expect(bodyCancelledOnTimeout).toBe(true);

      // 6B. AbortSignal fired after headers arrive while body is streaming aborts immediately and cancels body
      let bodyCancelledOnAbort = false;
      const abortController = new AbortController();
      const abortDuringBodyFetch: typeof fetch = vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"places":['));
            setTimeout(() => abortController.abort(), 15);
          },
          cancel() {
            bodyCancelledOnAbort = true;
          },
        });
        return new Response(stream, {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      });

      const abortLib = new ScoutToolLibrary({
        googlePlacesApiKey: 'test-places-key',
        fetchImpl: abortDuringBodyFetch,
        upstreamTimeoutMs: 2000,
      });

      await expect(
        abortLib.resolveAndStandardizePlace(
          { query: 'Maverik Sedona' },
          { abortSignal: abortController.signal } as ScoutToolExecutionContext
        )
      ).rejects.toThrow('Request aborted');
      expect(bodyCancelledOnAbort).toBe(true);

      // 6C. Malformed JSON response body rejects deterministically
      const malformedJsonFetch: typeof fetch = vi.fn(async () => {
        return new Response('{broken_json_body', {
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
        });
      });
      const malformedLib = new ScoutToolLibrary({
        braveSearchApiKey: 'test-key',
        fetchImpl: malformedJsonFetch,
      });
      await expect(malformedLib.searchWeb({ query: 'Sedona' }, {} as ScoutToolExecutionContext)).rejects.toThrow();
    });
});
