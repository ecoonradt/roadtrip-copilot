import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import dns from 'node:dns';
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';
import tzlookup from 'tz-lookup';
import type { ToolDeclaration } from '../types/ai.js';
import type { ScoutTripContext, ScoutWaypointSummary, ScoutScope } from '../types/scout.js';
import { RouteService, defaultRouteService } from './routeService.js';
import { isValidGooglePlaceId } from './placeId.js';

export const BRAVE_SEARCH_BASE_URL = 'https://api.search.brave.com/res/v1/web/search';
export const GOOGLE_PLACES_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
export const GOOGLE_PLACES_FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.regularOpeningHours';
export const OSRM_NEAREST_BASE_URL = 'https://router.project-osrm.org/nearest/v1/driving';
export const DEFAULT_GOOGLE_PLACES_SSM_PARAM = '/roadtrip-copilot/google-places-api-key';
export const DEFAULT_BRAVE_SEARCH_SSM_PARAM = '/roadtrip-copilot/brave-search-api-key';
export const CONFIG_CACHE_TTL_MS = 15 * 60 * 1000;
export const LOAD_RETRY_COOLDOWN_MS = 30 * 1000;
export const MAX_AUDIT_WAYPOINTS = 50;
export const MAX_AUDIT_CONCURRENCY = 4;

export interface ResolvedPlaceRecord {
  query: string;
  place_name: string;
  display_name: string;
  address: string;
  lat: number;
  lng: number;
  google_place_id?: string;
  types?: string[];
  weekday_descriptions?: string[];
}

export interface TurnGroundingCache {
  resolvedPlaces: ResolvedPlaceRecord[];
  knownPlaceIds: Set<string>;
}

export interface ScoutToolExecutionContext {
  tripContext: ScoutTripContext;
  scope?: ScoutScope;
  abortSignal?: AbortSignal;
  groundingCache?: TurnGroundingCache;
}

export type DnsLookupFn = (
  hostname: string
) => Promise<Array<{ address: string; family: number }>>;

export interface SafeUrlValidationResult {
  url: URL;
  addresses: Array<{ address: string; family: number }>;
}

export interface DnsValidationOptions {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface ScoutToolLibraryOptions {
  ssmClient?: SSMClient;
  region?: string;
  googlePlacesApiKey?: string;
  googlePlacesApiKeySsmParam?: string;
  braveSearchApiKey?: string;
  braveSearchApiKeySsmParam?: string;
  routeService?: RouteService;
  osrmNearestBaseUrl?: string;
  fetchImpl?: typeof fetch;
  dnsLookup?: DnsLookupFn;
  maxUrlChars?: number;
  urlTimeoutMs?: number;
  upstreamTimeoutMs?: number;
}

export const SCOUT_TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: 'search_web',
    description:
      'Searches the web using Brave Search for up-to-date road trip information, local attractions, commercial amenities, or operating hours.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query string',
        },
        count: {
          type: 'number',
          description: 'Optional max results (1-10, default 5)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_url_content',
    description:
      'Fetches an external HTTP/HTTPS URL and extracts readable text content. Enforces strict SSRF protection, redirect limits, and size caps.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'HTTP/HTTPS URL to fetch and extract readable text from',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'resolve_and_standardize_place',
    description:
      'Resolves and standardizes a commercial establishment, scenic overlook, or place of interest via Google Places API (New), retrieving verified place IDs, addresses, coordinates, and operating hours.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Establishment name and city/highway context (e.g. "Maverik Flagstaff", "Red Rock Scenic Byway")',
        },
        lat: {
          type: 'number',
          description: 'Optional latitude for geographic biasing',
        },
        lng: {
          type: 'number',
          description: 'Optional longitude for geographic biasing',
        },
        radius_miles: {
          type: 'number',
          description: 'Optional search radius in miles (default 15, max ~31 miles / 50km)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'snap_to_highway_corridor',
    description:
      'Snaps coordinates to the nearest active highway centerline using OSRM to ensure drive-by waypoints and scenic triggers do not depart the highway onto service roads or residential streets.',
    inputSchema: {
      type: 'object',
      properties: {
        lat: {
          type: 'number',
          description: 'Latitude to snap',
        },
        lng: {
          type: 'number',
          description: 'Longitude to snap',
        },
        road_name: {
          type: 'string',
          description:
            'Optional highway designation (e.g. US-89, AZ-179, I-40) to select among candidates',
        },
      },
      required: ['lat', 'lng'],
    },
  },
  {
    name: 'calculate_detour_impact',
    description:
      'Calculates the exact added driving distance and duration for inserting a candidate waypoint into the active route corridor using OSRM.',
    inputSchema: {
      type: 'object',
      properties: {
        candidate_lat: {
          type: 'number',
          description: 'Candidate waypoint latitude',
        },
        candidate_lng: {
          type: 'number',
          description: 'Candidate waypoint longitude',
        },
        after_waypoint_id: {
          type: 'string',
          description: 'ID of the existing waypoint after which the candidate will be inserted',
        },
      },
      required: ['candidate_lat', 'candidate_lng', 'after_waypoint_id'],
    },
  },
  {
    name: 'simulate_schedule_cascade',
    description:
      'Simulates the forward schedule cascade across the day upon adding, updating, or deleting a waypoint, recalculating arrival and departure times, timezone changes, and sunset warnings.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'update', 'delete'],
          description: 'Simulation action',
        },
        target_waypoint_id: {
          type: 'string',
          description: 'Target waypoint ID to add after, update, or delete',
        },
        dwell_minutes: {
          type: 'number',
          description: 'Optional dwell minutes for added or updated waypoint',
        },
        candidate_lat: {
          type: 'number',
          description: 'Optional latitude for added or updated waypoint',
        },
        candidate_lng: {
          type: 'number',
          description: 'Optional longitude for added or updated waypoint',
        },
        candidate_name: {
          type: 'string',
          description: 'Optional name for added or updated waypoint',
        },
        candidate_type: {
          type: 'string',
          description: 'Optional waypoint category type',
        },
      },
      required: ['action', 'target_waypoint_id'],
    },
  },
  {
    name: 'audit_corridor_waypoints',
    description:
      'Audits all waypoints along the active corridor for highway alignment, low-speed detour anomalies, invalid Google Place IDs, physical stop metadata, and speech/alert consistency.',
    inputSchema: {
      type: 'object',
      properties: {
        day_number: {
          type: 'number',
          description: 'Optional day number to audit',
        },
      },
    },
  },
];

/**
 * Trims rawName, strips parenthetical qualifiers (...), and if cleaned contains slashes,
 * takes the last non-empty slash segment (e.g. "Flagstaff / Little America Hotel (East)" -> "Little America Hotel").
 */
export function cleanPlaceName(rawName: string): string {
  if (!rawName || typeof rawName !== 'string') return '';
  let cleaned = rawName.trim().replace(/\s*\([^)]*\)/g, '').trim();
  if (cleaned.includes('/')) {
    const segments = cleaned
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length > 0) {
      cleaned = segments[segments.length - 1];
    }
  }
  return cleaned.trim();
}

function isPrivateOrReservedIpv4(a: number, b: number, c: number): boolean {
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (Loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (Link-local / AWS IMDS)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 (6to4 Relay Anycast)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true; // Multicast & reserved (224.0.0.0/4 and 240.0.0.0/4)
  return false;
}

function parseIpv6Groups(rawHost: string): number[] | null {
  const host = rawHost.split('%')[0]; // Strip zone ID if present
  if (!host.includes(':')) return null;

  // Handle trailing dotted-quad IPv4 (e.g. ::ffff:127.0.0.1 or ::ffff:0:127.0.0.1)
  let working = host;
  const lastColon = working.lastIndexOf(':');
  if (lastColon !== -1 && working.slice(lastColon + 1).includes('.')) {
    const ipv4Part = working.slice(lastColon + 1);
    const octets = ipv4Part.split('.').map((p) => parseInt(p, 10));
    if (octets.length !== 4 || octets.some((n) => isNaN(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    working = `${working.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const doubleColonParts = working.split('::');
  if (doubleColonParts.length > 2) return null;

  const parseSegmentList = (part: string): number[] | null => {
    if (!part) return [];
    const segs = part.split(':');
    const nums: number[] = [];
    for (const seg of segs) {
      if (!/^[0-9a-f]{1,4}$/i.test(seg)) return null;
      nums.push(parseInt(seg, 16));
    }
    return nums;
  };

  if (doubleColonParts.length === 2) {
    const left = parseSegmentList(doubleColonParts[0]);
    const right = parseSegmentList(doubleColonParts[1]);
    if (!left || !right || left.length + right.length > 8) return null;
    const fillCount = 8 - (left.length + right.length);
    return [...left, ...new Array<number>(fillCount).fill(0), ...right];
  }

  const full = parseSegmentList(working);
  if (!full || full.length !== 8) return null;
  return full;
}

/**
 * Validates that an IPv4 or IPv6 literal address is not in any private, loopback,
 * link-local, unique-local, multicast, or cloud metadata range.
 */
export function assertSafeIpAddress(rawIp: string): void {
  const ip = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!ip) {
    throw new Error('Blocked IP: empty address');
  }

  // IPv4 literal check
  const ipv4Parts = ip.split('.');
  if (ipv4Parts.length === 4 && ipv4Parts.every((p) => /^\d+$/.test(p))) {
    const octets = ipv4Parts.map((p) => parseInt(p, 10));
    if (octets.some((o) => o < 0 || o > 255)) {
      throw new Error(`Blocked URL: invalid IPv4 address "${ip}"`);
    }
    const [a, b, c] = octets;
    if (isPrivateOrReservedIpv4(a, b, c)) {
      throw new Error(`Blocked URL: private or reserved IPv4 address "${ip}"`);
    }
    return;
  }

  // IPv6 literal check
  if (ip.includes(':')) {
    const groups = parseIpv6Groups(ip);
    if (!groups) {
      throw new Error(`Blocked URL: invalid IPv6 address "${ip}"`);
    }

    const isFirstFourZero = groups.slice(0, 4).every((g) => g === 0);
    const isAllZeroPrefix = isFirstFourZero && groups[4] === 0;

    // Loopback ::1 or unspecified ::
    if (isAllZeroPrefix && groups[5] === 0 && groups[6] === 0 && (groups[7] === 0 || groups[7] === 1)) {
      throw new Error(`Blocked URL: IPv6 loopback or unspecified address "${ip}"`);
    }

    // IPv4-mapped ::ffff:w6:w7, IPv4-compatible ::w6:w7, or IPv4-translated ::ffff:0:w6:w7
    if (
      (isAllZeroPrefix && (groups[5] === 0xffff || groups[5] === 0)) ||
      (isFirstFourZero && groups[4] === 0xffff && groups[5] === 0)
    ) {
      const a = (groups[6] >> 8) & 0xff;
      const b = groups[6] & 0xff;
      const c = (groups[7] >> 8) & 0xff;
      if (isPrivateOrReservedIpv4(a, b, c)) {
        throw new Error(`Blocked URL: private IPv4-mapped IPv6 address "${ip}"`);
      }
    }

    // Local-use NAT64 64:ff9b:1::/48
    if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0x0001) {
      throw new Error(`Blocked URL: private NAT64 IPv6 address "${ip}"`);
    }

    // Well-known NAT64 64:ff9b::/96
    if (groups[0] === 0x0064 && groups[1] === 0xff9b) {
      const a = (groups[6] >> 8) & 0xff;
      const b = groups[6] & 0xff;
      const c = (groups[7] >> 8) & 0xff;
      if (isPrivateOrReservedIpv4(a, b, c)) {
        throw new Error(`Blocked URL: private NAT64 IPv6 address "${ip}"`);
      }
    }

    // 6to4 2002::/16 (embeds IPv4 in groups[1] and groups[2])
    if (groups[0] === 0x2002) {
      const a = (groups[1] >> 8) & 0xff;
      const b = groups[1] & 0xff;
      const c = (groups[2] >> 8) & 0xff;
      if (isPrivateOrReservedIpv4(a, b, c)) {
        throw new Error(`Blocked URL: private 6to4 IPv6 address "${ip}"`);
      }
    }

    // Teredo tunneling 2001:0000::/32
    if (groups[0] === 0x2001 && groups[1] === 0x0000) {
      throw new Error(`Blocked URL: Teredo IPv6 address "${ip}"`);
    }

    // Unique local fc00::/7 (fc00::..fdff::, including AWS IMDS fd00:ec2::254)
    if ((groups[0] & 0xfe00) === 0xfc00) {
      throw new Error(`Blocked URL: IPv6 unique local address "${ip}"`);
    }

    // Link-local fe80::/10
    if ((groups[0] & 0xffc0) === 0xfe80) {
      throw new Error(`Blocked URL: IPv6 link-local address "${ip}"`);
    }

    // Multicast ff00::/8
    if ((groups[0] & 0xff00) === 0xff00) {
      throw new Error(`Blocked URL: IPv6 multicast address "${ip}"`);
    }

    // Documentation 2001:db8::/32
    if (groups[0] === 0x2001 && groups[1] === 0x0db8) {
      throw new Error(`Blocked URL: IPv6 documentation address "${ip}"`);
    }
  }
}

const FORBIDDEN_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.nip.io',
  '.sslip.io',
  '.xip.io',
  '.localtest.me',
  '.lvh.me',
  '.vcap.me',
  '.traefik.me',
];

const ALLOWED_EXTERNAL_PORTS = new Set(['', '80', '443', '8080', '8443']);

/**
 * Validates and normalizes an external URL, rejecting private/internal networks,
 * loopback, link-local, cloud metadata services, wildcard DNS rebinding domains, and credentials.
 */
export function assertSafeExternalUrl(rawUrl: string): URL {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('Invalid URL: URL must be a non-empty string');
  }

  const trimmed = rawUrl.trim();
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error('Blocked URL: control characters in URL are forbidden');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL format: "${rawUrl}"`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked URL: protocol must be http: or https:, received "${parsed.protocol}"`);
  }

  if (parsed.username || parsed.password) {
    throw new Error('Blocked URL: credentials in URL are forbidden');
  }

  // Strip IPv6 brackets and trailing FQDN dots (e.g. "localhost." or "metadata.google.internal.")
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!hostname) {
    throw new Error('Blocked URL: empty hostname');
  }

  // Reject local, internal, and wildcard rebinding hostnames
  if (
    hostname === 'localhost' ||
    hostname === 'metadata.google.internal' ||
    hostname === 'metadata' ||
    FORBIDDEN_HOST_SUFFIXES.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix))
  ) {
    throw new Error(`Blocked URL: forbidden internal hostname "${hostname}"`);
  }

  // Reject integer, hex, or shorthand numeric IPv4 hostnames
  if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname) || /^[0-9.]+$/.test(hostname)) {
    const ipv4Parts = hostname.split('.');
    if (ipv4Parts.length !== 4 || !ipv4Parts.every((p) => /^\d+$/.test(p) && (p === '0' || !p.startsWith('0')))) {
      throw new Error(`Blocked URL: non-standard numeric IPv4 literal "${hostname}" is forbidden`);
    }
  }

  assertSafeIpAddress(hostname);

  if (!ALLOWED_EXTERNAL_PORTS.has(parsed.port)) {
    throw new Error(`Blocked URL: port "${parsed.port}" is not allowed`);
  }

  return parsed;
}

/**
 * Resolves an external URL with SSRF validation and DNS record checks.
 */
export async function resolveValidatedUrlWithDns(
  rawUrl: string,
  dnsLookup: DnsLookupFn = (host) => dns.promises.lookup(host, { all: true, verbatim: true }),
  options?: DnsValidationOptions
): Promise<SafeUrlValidationResult> {
  if (options?.abortSignal?.aborted) {
    throw new Error('Request aborted');
  }
  const parsed = assertSafeExternalUrl(rawUrl);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');

  const isIpv4Literal = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  const isIpv6Literal = hostname.includes(':');

  if (isIpv4Literal) {
    assertSafeIpAddress(hostname);
    return { url: parsed, addresses: [{ address: hostname, family: 4 }] };
  }
  if (isIpv6Literal) {
    assertSafeIpAddress(hostname);
    return { url: parsed, addresses: [{ address: hostname, family: 6 }] };
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const lookupPromise = (async () => {
    try {
      return await dnsLookup(hostname);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`DNS resolution failed for "${hostname}": ${msg}`);
    }
  })();

  const controlPromise = new Promise<never>((_resolve, reject) => {
    if (options?.abortSignal) {
      if (options.abortSignal.aborted) {
        reject(new Error('Request aborted'));
        return;
      }
      onAbort = () => reject(new Error('Request aborted'));
      options.abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    if (options?.timeoutMs !== undefined && Number.isFinite(options.timeoutMs)) {
      const ms = Math.max(1, options.timeoutMs);
      timeoutId = setTimeout(() => {
        reject(new Error(`Request timed out after ${ms}ms: ${rawUrl}`));
      }, ms);
    }
  });

  let records: Array<{ address: string; family: number }>;
  try {
    records = await Promise.race([lookupPromise, controlPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (onAbort && options?.abortSignal) {
      options.abortSignal.removeEventListener('abort', onAbort);
    }
  }

  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`DNS resolution returned no addresses for "${hostname}"`);
  }

  const validatedAddresses: Array<{ address: string; family: number }> = [];
  for (const rec of records) {
    if (!rec || typeof rec.address !== 'string') {
      throw new Error(`DNS resolution returned invalid record for "${hostname}"`);
    }
    assertSafeIpAddress(rec.address);
    const cleanAddr = rec.address.trim().replace(/^\[|\]$/g, '');
    const family = rec.family === 6 || cleanAddr.includes(':') ? 6 : 4;
    validatedAddresses.push({ address: cleanAddr, family });
  }

  return { url: parsed, addresses: validatedAddresses };
}

/**
 * Validates an external URL and resolves its DNS records (when not an IP literal)
 * to ensure no A/AAAA record points to a private, loopback, or metadata IP.
 */
export async function assertSafeExternalUrlWithDns(
  rawUrl: string,
  dnsLookup: DnsLookupFn = (host) => dns.promises.lookup(host, { all: true, verbatim: true }),
  options?: DnsValidationOptions
): Promise<URL> {
  const res = await resolveValidatedUrlWithDns(rawUrl, dnsLookup, options);
  return res.url;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return '';
      }
      return String.fromCodePoint(code);
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return '';
      }
      return String.fromCodePoint(code);
    })
    // Decode &amp; last to prevent double-decoding (e.g. &amp;lt; -> &lt;, not <)
    .replace(/&amp;/g, '&');
}

/**
 * Linear O(n) stripper for paired HTML blocks (e.g. <script>...</script>) that cannot backtrack
 * quadratically on malformed/unterminated tags and strips any unclosed trailing block to EOF.
 */
function stripTagBlocksLinear(input: string, tagName: string): string {
  const lower = input.toLowerCase();
  const openToken = `<${tagName}`;
  const closeToken = `</${tagName}`;
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    const startIdx = lower.indexOf(openToken, cursor);
    if (startIdx === -1) {
      chunks.push(input.slice(cursor));
      break;
    }

    const afterTagChar = lower[startIdx + openToken.length];
    if (
      afterTagChar !== undefined &&
      afterTagChar !== '>' &&
      afterTagChar !== '/' &&
      afterTagChar !== ' ' &&
      afterTagChar !== '\t' &&
      afterTagChar !== '\n' &&
      afterTagChar !== '\r'
    ) {
      chunks.push(input.slice(cursor, startIdx + openToken.length));
      cursor = startIdx + openToken.length;
      continue;
    }

    chunks.push(input.slice(cursor, startIdx));

    const openTagEnd = lower.indexOf('>', startIdx + openToken.length);
    if (openTagEnd === -1) {
      // Unterminated opening tag -> drop remainder of input
      break;
    }

    // Self-closing tag e.g. <iframe src="..." />
    if (lower[openTagEnd - 1] === '/') {
      cursor = openTagEnd + 1;
      continue;
    }

    const closeIdx = lower.indexOf(closeToken, openTagEnd + 1);
    if (closeIdx === -1) {
      // Unclosed block tag -> drop remainder of input
      break;
    }

    const closeTagEnd = lower.indexOf('>', closeIdx + closeToken.length);
    if (closeTagEnd === -1) {
      break;
    }
    cursor = closeTagEnd + 1;
  }

  return chunks.join('');
}

function classifyHtmlTagReplacement(rawInside: string): string {
  const trimmed = rawInside.trim();
  if (!trimmed) return ' ';

  if (trimmed[0] === '/') {
    const closeName = trimmed.slice(1).trim().toLowerCase();
    if (closeName === 'li') return '';
    if (
      closeName === 'p' ||
      closeName === 'div' ||
      closeName === 'tr' ||
      closeName === 'table' ||
      closeName === 'section' ||
      closeName === 'article' ||
      (closeName.length === 2 && closeName[0] === 'h' && closeName[1] >= '1' && closeName[1] <= '6')
    ) {
      return '\n\n';
    }
    return ' ';
  }

  let endIdx = 0;
  while (endIdx < trimmed.length) {
    const ch = trimmed[endIdx];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '/') {
      break;
    }
    endIdx++;
  }
  const openName = trimmed.slice(0, endIdx).toLowerCase();
  if (openName === 'br') return '\n';
  if (openName === 'li') return '\n* ';
  return ' ';
}

function stripAndFormatHtmlTagsLinear(input: string): string {
  const chunks: string[] = [];
  let cursor = 0;
  const len = input.length;

  while (cursor < len) {
    const ltIdx = input.indexOf('<', cursor);
    if (ltIdx === -1) {
      chunks.push(input.slice(cursor));
      break;
    }
    if (ltIdx > cursor) {
      chunks.push(input.slice(cursor, ltIdx));
    }
    const gtIdx = input.indexOf('>', ltIdx + 1);
    if (gtIdx === -1) {
      // Unterminated tag or trailing '<' sequence without closing '>' -> drop to EOF in O(1)
      break;
    }
    // If there are nested '<' inside [ltIdx + 1, gtIdx), check the innermost '<' before gtIdx for tag classification
    const lastLt = input.lastIndexOf('<', gtIdx - 1);
    const tagStart = lastLt > ltIdx ? lastLt : ltIdx;
    chunks.push(classifyHtmlTagReplacement(input.slice(tagStart + 1, gtIdx)));
    cursor = gtIdx + 1;
  }

  return chunks.join('');
}

function extractTitleLinear(html: string): string | undefined {
  const lower = html.toLowerCase();
  const startIdx = lower.indexOf('<title');
  if (startIdx === -1) return undefined;
  const openEnd = lower.indexOf('>', startIdx + 6);
  if (openEnd === -1) return undefined;
  const closeIdx = lower.indexOf('</title', openEnd + 1);
  if (closeIdx === -1) return undefined;
  const rawTitle = decodeHtmlEntities(html.slice(openEnd + 1, closeIdx).replace(/\s+/g, ' ').trim());
  if (!rawTitle) return undefined;
  return rawTitle.length > 300 ? rawTitle.slice(0, 300) : rawTitle;
}

/**
 * Extracts page title and converts HTML to readable plain text / markdown representation
 * in linear O(n) time without ReDoS vulnerability.
 */
export function htmlToReadableText(html: string): { title?: string; text: string } {
  if (!html || typeof html !== 'string') return { text: '' };

  const title = extractTitleLinear(html);

  let text = html;
  for (const tag of ['script', 'style', 'noscript', 'svg', 'iframe']) {
    text = stripTagBlocksLinear(text, tag);
  }

  text = stripAndFormatHtmlTagsLinear(text);

  text = decodeHtmlEntities(text);
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text };
}

/**
 * Creates an isolated turn-level grounding cache.
 */
export function createTurnGroundingCache(waypoints?: ScoutWaypointSummary[]): TurnGroundingCache {
  return {
    resolvedPlaces: [],
    knownPlaceIds: new Set(
      (waypoints || [])
        .map((w) => w.google_place_id)
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0 && isValidGooglePlaceId(id))
        .map((id) => id.trim())
    ),
  };
}

/**
 * Calculates great-circle distance between two coordinates in statute miles.
 */
export function haversineMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  if (lat1 === lat2 && lng1 === lng2) return 0;
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Number((R * c).toFixed(4));
}

/**
 * Detects timezone based on geographic coordinates or falls back to 'UTC'.
 */
export function detectTimezone(lat: number, lng: number, fallback = 'UTC'): string {
  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return fallback;
  }
  try {
    return tzlookup(lat, lng);
  } catch {
    return fallback;
  }
}

export interface HighwayDesignator {
  kind: 'interstate' | 'us' | 'state';
  stateCode?: string;
  number: string;
}

const US_STATE_PRIMARY_CODES = new Set([
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga',
  'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md',
  'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj',
  'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc',
  'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy',
  'dc', 'pr',
]);

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseHighwayDesignators(name: string): HighwayDesignator[] {
  if (!name || typeof name !== 'string') return [];
  const lower = name.toLowerCase();
  const results: HighwayDesignator[] = [];

  // Match Interstates:
  const interstateRegex =
    /\b(?:i|ih|interstate(?:\s+(?:highway|hwy|route|rt))?)[\s\-]+(\d+[a-z]?)\b|\b(?:i|ih)(\d+[a-z]?)\b/g;
  let remaining = lower.replace(interstateRegex, (match, p1, p2) => {
    const num = (p1 || p2 || '').trim();
    if (num) {
      results.push({ kind: 'interstate', number: num });
    }
    return ' '.repeat(match.length);
  });

  // Match US Highways:
  const usRegex = /\b(?:u\.?s\.?|united\s+states)(?:[\s\-]+(?:highway|hwy|route|rt))?[\s\-]*(\d+[a-z]?)\b/g;
  remaining = remaining.replace(usRegex, (match, p1) => {
    const num = (p1 || '').trim();
    if (num) {
      results.push({ kind: 'us', number: num });
    }
    return ' '.repeat(match.length);
  });

  // Match State Routes on remaining string:
  // 1. Generic prefix
  const genericStateRegex =
    /\b(?:state[\s\-]+(?:route|highway|hwy|rd|road|rt)|sr|sh|sp|fm|rm|highway|hwy|route|rt)[\s\-]*(\d+[a-z]?)\b/g;
  remaining = remaining.replace(genericStateRegex, (match, p1) => {
    const num = (p1 || '').trim();
    if (num) {
      results.push({ kind: 'state', number: num });
    }
    return ' '.repeat(match.length);
  });

  // 2. State code prefix
  const stateCodeRegex = /\b([a-z]{2})[\s\-]*(\d+[a-z]?)\b/g;
  for (const m of remaining.matchAll(stateCodeRegex)) {
    const code = m[1];
    const num = (m[2] || '').trim();
    if (US_STATE_PRIMARY_CODES.has(code) && num) {
      results.push({ kind: 'state', stateCode: code, number: num });
    }
  }

  return results;
}

export function matchesHighwayRoadName(candidateRoadName: string, targetRoadName: string): boolean {
  const rawCand = candidateRoadName ? candidateRoadName.trim() : '';
  const rawTarget = targetRoadName ? targetRoadName.trim() : '';
  if (!rawCand || !rawTarget) return false;

  const targetDesignators = parseHighwayDesignators(rawTarget);
  const candDesignators = parseHighwayDesignators(rawCand);

  if (targetDesignators.length > 0 || candDesignators.length > 0) {
    if (targetDesignators.length === 0 || candDesignators.length === 0) {
      return false;
    }
    return targetDesignators.some((td) =>
      candDesignators.some(
        (cd) =>
          td.kind === cd.kind &&
          td.number === cd.number &&
          (!td.stateCode || !cd.stateCode || td.stateCode === cd.stateCode)
      )
    );
  }

  // When neither has highway designators
  const candNorm = rawCand.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const targetNorm = rawTarget.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  if (!candNorm || !targetNorm) return false;
  if (candNorm === targetNorm) return true;

  if (Math.min(candNorm.length, targetNorm.length) >= 4) {
    const targetWordRegex = new RegExp(`(?:^|\\s)${escapeRegExp(targetNorm)}(?:$|\\s)`);
    const candWordRegex = new RegExp(`(?:^|\\s)${escapeRegExp(candNorm)}(?:$|\\s)`);
    if (targetWordRegex.test(candNorm) || candWordRegex.test(targetNorm)) {
      return true;
    }
  }

  return false;
}

function raceWithAbort<T>(promise: Promise<T>, abortSignal?: AbortSignal): Promise<T> {
  if (!abortSignal) return promise;
  if (abortSignal.aborted) {
    return Promise.reject(new Error('Request aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new Error('Request aborted'));
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (val) => {
        abortSignal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        abortSignal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

interface RawGooglePlacesTextSearchResponse {
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude: number; longitude: number };
    types?: string[];
    regularOpeningHours?: { weekdayDescriptions?: string[] };
  }>;
}

interface RawBraveSearchResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
    }>;
  };
}

interface RawOsrmNearestResponse {
  code?: string;
  waypoints?: Array<{
    distance?: number;
    name?: string;
    location: [number, number]; // [lon, lat]
  }>;
}

/**
 * Discovery + Deterministic Domain Grounding Tool Library.
 */
export class ScoutToolLibrary {
  private readonly options: ScoutToolLibraryOptions;
  private ssmClient: SSMClient | null = null;

  private braveApiKeyCached: string | null = null;
  private braveApiKeyLoadedAt = 0;
  private braveApiKeyFailedAt = 0;
  private braveApiKeyLoadPromise: Promise<string> | null = null;

  private googlePlacesApiKeyCached: string | null = null;
  private googlePlacesApiKeyLoadedAt = 0;
  private googlePlacesApiKeyFailedAt = 0;
  private googlePlacesApiKeyLoadPromise: Promise<string> | null = null;

  constructor(options: ScoutToolLibraryOptions = {}) {
    this.options = options;
  }

  private getSsmClient(): SSMClient {
    if (this.options.ssmClient) return this.options.ssmClient;
    if (!this.ssmClient) {
      const region = this.options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
      this.ssmClient = new SSMClient(region ? { region } : {});
    }
    return this.ssmClient;
  }

  public async fetchWithTimeout(
    url: string,
    init: RequestInit,
    abortSignal?: AbortSignal,
    customTimeoutMs?: number
  ): Promise<Response> {
    if (abortSignal?.aborted) {
      throw new Error('Request aborted');
    }
    const timeoutMs = customTimeoutMs ?? this.options.upstreamTimeoutMs ?? 10_000;
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
    const onAbort = () => timeoutController.abort();
    if (abortSignal) {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    const fetchFn = this.options.fetchImpl ?? fetch;
    try {
      return await fetchFn(url, {
        ...init,
        signal: timeoutController.signal,
      });
    } catch (err: unknown) {
      if (abortSignal?.aborted) {
        throw new Error('Request aborted');
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Upstream request timed out after ${timeoutMs}ms: ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort);
      }
    }
  }

  private async fetchJsonWithTimeout<T>(
    url: string,
    init: RequestInit,
    upstreamLabel: string,
    abortSignal?: AbortSignal,
    customTimeoutMs?: number
  ): Promise<T> {
    if (abortSignal?.aborted) {
      throw new Error('Request aborted');
    }
    const timeoutMs = customTimeoutMs ?? this.options.upstreamTimeoutMs ?? 10_000;
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
    const onAbort = () => timeoutController.abort();
    if (abortSignal) {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    const fetchFn = this.options.fetchImpl ?? fetch;
    let res: Response | undefined;
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    const controlPromise = new Promise<never>((_resolve, reject) => {
      const abortHandler = () => {
        if (activeReader) {
          void activeReader.cancel().catch(() => {});
        } else if (res?.body && !res.body.locked) {
          void res.body.cancel().catch(() => {});
        }
        if (abortSignal?.aborted) {
          reject(new Error('Request aborted'));
        } else {
          reject(new Error(`Upstream request timed out after ${timeoutMs}ms: ${url}`));
        }
      };
      if (timeoutController.signal.aborted) {
        abortHandler();
        return;
      }
      timeoutController.signal.addEventListener('abort', abortHandler, { once: true });
    });

    const executionPromise = (async (): Promise<T> => {
      try {
        res = await fetchFn(url, {
          ...init,
          signal: timeoutController.signal,
        });
      } catch (err: unknown) {
        if (abortSignal?.aborted) {
          throw new Error('Request aborted');
        }
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error(`Upstream request timed out after ${timeoutMs}ms: ${url}`);
        }
        throw err;
      }

      if (!res.ok) {
        try {
          await res.body?.cancel();
        } catch {
          // ignore
        }
        throw new Error(`${upstreamLabel} failed with HTTP ${res.status}`);
      }

      try {
        if (res.body && typeof res.body.getReader === 'function') {
          activeReader = res.body.getReader();
          const decoder = new TextDecoder('utf-8');
          const chunks: string[] = [];
          while (true) {
            const { done, value } = await activeReader.read();
            if (timeoutController.signal.aborted) {
              throw new Error('AbortError');
            }
            if (done) break;
            if (value) {
              chunks.push(decoder.decode(value, { stream: true }));
            }
          }
          chunks.push(decoder.decode());
          return JSON.parse(chunks.join('')) as T;
        }
        return (await res.json()) as T;
      } catch (err: unknown) {
        if (abortSignal?.aborted) {
          throw new Error('Request aborted');
        }
        if (timeoutController.signal.aborted) {
          throw new Error(`Upstream request timed out after ${timeoutMs}ms: ${url}`);
        }
        throw err;
      }
    })();

    try {
      return await Promise.race([executionPromise, controlPromise]);
    } finally {
      clearTimeout(timeoutId);
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort);
      }
    }
  }

  private requestPinnedUrl(
    validated: SafeUrlValidationResult,
    headers: Record<string, string>,
    signal: AbortSignal
  ): Promise<Response> {
    const cleanHostname = validated.url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    const isIpLiteral = /^\d+\.\d+\.\d+\.\d+$/.test(cleanHostname) || cleanHostname.includes(':');
    const isHttps = validated.url.protocol === 'https:';
    const transport = isHttps ? https : http;

    return new Promise<Response>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Request aborted'));
        return;
      }

      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        req.destroy(new Error('Request aborted'));
        reject(new Error('Request aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      const reqOptions: https.RequestOptions = {
        protocol: validated.url.protocol,
        hostname: cleanHostname,
        port: validated.url.port ? Number(validated.url.port) : isHttps ? 443 : 80,
        path: `${validated.url.pathname}${validated.url.search}`,
        method: 'GET',
        headers: {
          ...headers,
          Host: validated.url.host,
          'Accept-Encoding': 'identity',
        },
        agent: false,
        signal,
        ...(isHttps && !isIpLiteral ? { servername: cleanHostname } : {}),
        lookup: (_host, lookupOpts, callback) => {
          try {
            for (const addr of validated.addresses) {
              assertSafeIpAddress(addr.address);
            }
            const primary = validated.addresses[0];
            const wantAll =
              typeof lookupOpts === 'object' &&
              lookupOpts !== null &&
              'all' in lookupOpts &&
              Boolean((lookupOpts as { all?: boolean }).all);
            if (wantAll) {
              (callback as (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void)(
                null,
                validated.addresses.map((a) => ({ address: a.address, family: a.family }))
              );
            } else {
              (callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
                null,
                primary.address,
                primary.family
              );
            }
          } catch (err: unknown) {
            const error = err instanceof Error ? err : new Error(String(err));
            (callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
              error as NodeJS.ErrnoException,
              '',
              4
            );
          }
        },
      };

      const req = transport.request(reqOptions, (incoming) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);

        const resHeaders = new Headers();
        for (const [key, val] of Object.entries(incoming.headers)) {
          if (val === undefined) continue;
          if (Array.isArray(val)) {
            for (const item of val) {
              resHeaders.append(key, item);
            }
          } else {
            resHeaders.set(key, val);
          }
        }

        let bodyStream: NodeJS.ReadableStream = incoming;
        const contentEncoding = (resHeaders.get('content-encoding') || '').toLowerCase().trim();
        if (contentEncoding === 'gzip') {
          const decompressor = zlib.createGunzip();
          incoming.pipe(decompressor);
          bodyStream = decompressor;
          resHeaders.delete('content-encoding');
        } else if (contentEncoding === 'deflate') {
          const decompressor = zlib.createInflate();
          incoming.pipe(decompressor);
          bodyStream = decompressor;
          resHeaders.delete('content-encoding');
        } else if (contentEncoding === 'br') {
          const decompressor = zlib.createBrotliDecompress();
          incoming.pipe(decompressor);
          bodyStream = decompressor;
          resHeaders.delete('content-encoding');
        }

        const webStream = new ReadableStream<Uint8Array>({
          start(controller) {
            bodyStream.on('data', (chunk: Buffer | Uint8Array) => {
              controller.enqueue(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
            });
            bodyStream.on('end', () => {
              try {
                controller.close();
              } catch {
                // already closed
              }
            });
            bodyStream.on('error', (err) => {
              try {
                controller.error(err);
              } catch {
                // already errored
              }
            });
          },
          cancel() {
            if ('destroy' in bodyStream && typeof (bodyStream as { destroy?: () => void }).destroy === 'function') {
              (bodyStream as { destroy: () => void }).destroy();
            }
            incoming.destroy();
            req.destroy();
          },
        });

        resolve(
          new Response(webStream, {
            status: incoming.statusCode ?? 500,
            statusText: incoming.statusMessage ?? '',
            headers: resHeaders,
          })
        );
      });

      req.on('error', (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(err);
      });

      req.on('socket', (socket) => {
        socket.on('connect', () => {
          if (socket.remoteAddress) {
            try {
              assertSafeIpAddress(socket.remoteAddress);
            } catch (err: unknown) {
              req.destroy(err instanceof Error ? err : new Error(String(err)));
            }
          }
        });
      });

      req.end();
    });
  }

  /**
   * Lazily resolves the Brave Search API key from options, environment, or SSM Parameter Store.
   * Shared in-flight SSM loads are isolated from individual caller AbortSignals so one caller's abort
   * cannot cancel or poison the cooldown for other concurrent requests.
   */
  public async resolveBraveSearchApiKey(abortSignal?: AbortSignal): Promise<string> {
    if (abortSignal?.aborted) {
      throw new Error('Request aborted');
    }

    const direct = this.options.braveSearchApiKey || process.env.BRAVE_SEARCH_API_KEY;
    if (direct && direct.trim().length > 0) {
      return direct.trim();
    }

    const now = Date.now();
    if (this.braveApiKeyCached && now - this.braveApiKeyLoadedAt < CONFIG_CACHE_TTL_MS) {
      return this.braveApiKeyCached;
    }

    if (this.braveApiKeyFailedAt && now - this.braveApiKeyFailedAt < LOAD_RETRY_COOLDOWN_MS) {
      throw new Error('Brave Search API key is not configured or failed to load (in retry cooldown)');
    }

    if (!this.braveApiKeyLoadPromise) {
      const paramName =
        this.options.braveSearchApiKeySsmParam ??
        process.env.BRAVE_SEARCH_API_KEY_SSM_PARAM ??
        DEFAULT_BRAVE_SEARCH_SSM_PARAM;

      const loadPromise = (async () => {
        await Promise.resolve();
        try {
          const client = this.getSsmClient();
          const command = new GetParametersCommand({
            Names: [paramName],
            WithDecryption: true,
          });
          const res = await client.send(command);
          const param = res.Parameters?.find((p) => p.Name === paramName);
          const val = param?.Value?.trim();
          if (!val) {
            this.braveApiKeyFailedAt = Date.now();
            throw new Error(`Brave Search API key is not configured in environment or SSM Parameter: "${paramName}"`);
          }
          this.braveApiKeyCached = val;
          this.braveApiKeyLoadedAt = Date.now();
          this.braveApiKeyFailedAt = 0;
          return val;
        } catch (err: unknown) {
          this.braveApiKeyFailedAt = Date.now();
          throw err;
        }
      })();

      this.braveApiKeyLoadPromise = loadPromise;
      void loadPromise
        .finally(() => {
          if (this.braveApiKeyLoadPromise === loadPromise) {
            this.braveApiKeyLoadPromise = null;
          }
        })
        .catch(() => {
          // Handled by awaiting callers
        });
    }

    return raceWithAbort(this.braveApiKeyLoadPromise, abortSignal);
  }

  /**
   * Lazily resolves the Google Places API key from options, environment, or SSM Parameter Store.
   * Shared in-flight SSM loads are isolated from individual caller AbortSignals.
   */
  public async resolveGooglePlacesApiKey(abortSignal?: AbortSignal): Promise<string> {
    if (abortSignal?.aborted) {
      throw new Error('Request aborted');
    }

    const direct = this.options.googlePlacesApiKey || process.env.GOOGLE_PLACES_API_KEY;
    if (direct && direct.trim().length > 0) {
      return direct.trim();
    }

    const now = Date.now();
    if (this.googlePlacesApiKeyCached && now - this.googlePlacesApiKeyLoadedAt < CONFIG_CACHE_TTL_MS) {
      return this.googlePlacesApiKeyCached;
    }

    if (this.googlePlacesApiKeyFailedAt && now - this.googlePlacesApiKeyFailedAt < LOAD_RETRY_COOLDOWN_MS) {
      throw new Error('Google Places API key is not configured or failed to load (in retry cooldown)');
    }

    if (!this.googlePlacesApiKeyLoadPromise) {
      const paramName =
        this.options.googlePlacesApiKeySsmParam ??
        process.env.GOOGLE_PLACES_API_KEY_SSM_PARAM ??
        DEFAULT_GOOGLE_PLACES_SSM_PARAM;

      const loadPromise = (async () => {
        await Promise.resolve();
        try {
          const client = this.getSsmClient();
          const command = new GetParametersCommand({
            Names: [paramName],
            WithDecryption: true,
          });
          const res = await client.send(command);
          const param = res.Parameters?.find((p) => p.Name === paramName);
          const val = param?.Value?.trim();
          if (!val) {
            this.googlePlacesApiKeyFailedAt = Date.now();
            throw new Error(`Google Places API key is not configured in environment or SSM Parameter: "${paramName}"`);
          }
          this.googlePlacesApiKeyCached = val;
          this.googlePlacesApiKeyLoadedAt = Date.now();
          this.googlePlacesApiKeyFailedAt = 0;
          return val;
        } catch (err: unknown) {
          this.googlePlacesApiKeyFailedAt = Date.now();
          throw err;
        }
      })();

      this.googlePlacesApiKeyLoadPromise = loadPromise;
      void loadPromise
        .finally(() => {
          if (this.googlePlacesApiKeyLoadPromise === loadPromise) {
            this.googlePlacesApiKeyLoadPromise = null;
          }
        })
        .catch(() => {
          // Handled by awaiting callers
        });
    }

    return raceWithAbort(this.googlePlacesApiKeyLoadPromise, abortSignal);
  }

  /**
   * Dispatches execution of a registered Route Scout tool.
   */
  public async executeTool(
    name: string,
    args: Record<string, unknown>,
    context: ScoutToolExecutionContext
  ): Promise<unknown> {
    if (context.abortSignal?.aborted) {
      throw new Error('Request aborted');
    }

    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error('Tool arguments must be a JSON object');
    }

    let result: unknown;
    switch (name) {
      case 'search_web':
        result = await this.searchWeb(args, context);
        break;
      case 'read_url_content':
        result = await this.readUrlContent(args, context);
        break;
      case 'resolve_and_standardize_place':
        result = await this.resolveAndStandardizePlace(args, context);
        break;
      case 'snap_to_highway_corridor':
        result = await this.snapToHighwayCorridor(args, context);
        break;
      case 'calculate_detour_impact':
        result = await this.calculateDetourImpact(args, context);
        break;
      case 'simulate_schedule_cascade':
        result = await this.simulateScheduleCascade(args, context);
        break;
      case 'audit_corridor_waypoints':
        result = await this.auditCorridorWaypoints(args, context);
        break;
      default:
        throw new Error(`Unsupported Route Scout tool: "${name}"`);
    }

    if (context.abortSignal?.aborted) {
      throw new Error('Request aborted');
    }

    return result;
  }

  /**
   * Tool 1: search_web via Brave Search API.
   */
  public async searchWeb(
    args: Record<string, unknown>,
    context: ScoutToolExecutionContext
  ): Promise<{ query: string; results: Array<{ title: string; url: string; snippet: string }> }> {
    const rawQuery = typeof args.query === 'string' ? args.query.trim() : '';
    if (!rawQuery) {
      throw new Error('Missing required "query" argument for search_web');
    }

    const count =
      typeof args.count === 'number' && Number.isFinite(args.count)
        ? Math.min(10, Math.max(1, Math.round(args.count)))
        : 5;

    const apiKey = await this.resolveBraveSearchApiKey(context.abortSignal);
    const url = `${BRAVE_SEARCH_BASE_URL}?q=${encodeURIComponent(rawQuery)}&count=${count}`;

    const data = await this.fetchJsonWithTimeout<RawBraveSearchResponse>(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': apiKey,
        },
      },
      'Brave Search API',
      context.abortSignal
    );

    const rawResults = data.web?.results;
    const results = Array.isArray(rawResults)
      ? rawResults.map((r) => ({
          title: r.title?.trim() || '',
          url: r.url?.trim() || '',
          snippet: r.description?.trim() || '',
        }))
      : [];

    return {
      query: rawQuery,
      results,
    };
  }

  /**
   * Tool 2: read_url_content with SSRF protection, optional DNS validation, manual redirect validation, and size caps.
   */
  public async readUrlContent(
    args: Record<string, unknown>,
    context: ScoutToolExecutionContext
  ): Promise<{ url: string; title?: string; content: string; truncated: boolean }> {
    const rawUrl =
      typeof args.url === 'string' && args.url.trim().length > 0
        ? args.url.trim()
        : typeof args.Url === 'string' && args.Url.trim().length > 0
        ? args.Url.trim()
        : '';

    if (!rawUrl) {
      throw new Error('Missing required "url" argument for read_url_content');
    }

    const timeoutMs = this.options.urlTimeoutMs ?? 10_000;
    const deadlineMs = Date.now() + timeoutMs;
    const maxChars = this.options.maxUrlChars ?? 12_000;
    const maxBytes = 512 * 1024;
    const MAX_REDIRECTS = 3;
    let redirects = 0;

    const validateHop = async (targetUrl: string, remainingMs: number): Promise<SafeUrlValidationResult> => {
      if (this.options.dnsLookup || !this.options.fetchImpl) {
        return await resolveValidatedUrlWithDns(targetUrl, this.options.dnsLookup, {
          timeoutMs: remainingMs,
          abortSignal: context.abortSignal,
        });
      }
      const parsed = assertSafeExternalUrl(targetUrl);
      return { url: parsed, addresses: [] };
    };

    if (Date.now() >= deadlineMs) {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${rawUrl}`);
    }
    let validated = await validateHop(rawUrl, Math.max(1, deadlineMs - Date.now()));
    let currentUrl = validated.url.toString();

    while (true) {
      if (context.abortSignal?.aborted) {
        throw new Error('Request aborted');
      }

      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`Request timed out after ${timeoutMs}ms: ${currentUrl}`);
      }

      const hopTimeoutMs = Math.max(1, remainingMs);
      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), hopTimeoutMs);
      const abortHandler = () => timeoutController.abort();
      if (context.abortSignal) {
        context.abortSignal.addEventListener('abort', abortHandler, { once: true });
      }

      const raceStreamStep = <T>(promise: Promise<T>): Promise<T> => {
        if (timeoutController.signal.aborted) {
          if (context.abortSignal?.aborted) {
            return Promise.reject(new Error('Request aborted'));
          }
          return Promise.reject(new Error(`Request timed out after ${timeoutMs}ms: ${currentUrl}`));
        }
        return new Promise<T>((resolve, reject) => {
          const onAbort = () => {
            if (context.abortSignal?.aborted) {
              reject(new Error('Request aborted'));
            } else {
              reject(new Error(`Request timed out after ${timeoutMs}ms: ${currentUrl}`));
            }
          };
          timeoutController.signal.addEventListener('abort', onAbort, { once: true });
          promise.then(
            (val) => {
              timeoutController.signal.removeEventListener('abort', onAbort);
              resolve(val);
            },
            (err) => {
              timeoutController.signal.removeEventListener('abort', onAbort);
              reject(err);
            }
          );
        });
      };

      try {
        const headers: Record<string, string> = {
          'User-Agent': 'RoadtripCopilot-Scout/1.0 (https://github.com/roadtrip-copilot)',
          Accept: 'text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5',
        };

        let res: Response;
        if (this.options.fetchImpl) {
          res = await this.options.fetchImpl(currentUrl, {
            method: 'GET',
            redirect: 'manual',
            headers,
            signal: timeoutController.signal,
          });
        } else {
          res = await this.requestPinnedUrl(validated, headers, timeoutController.signal);
        }

        if ([301, 302, 303, 307, 308].includes(res.status)) {
          try {
            await res.body?.cancel();
          } catch {
            // ignore
          }
          redirects++;
          if (redirects > MAX_REDIRECTS) {
            throw new Error('Too many redirects');
          }
          const location = res.headers.get('location');
          if (!location) {
            throw new Error(`HTTP ${res.status} redirect without Location header`);
          }
          const resolvedNext = new URL(location, currentUrl).toString();
          const nextRemainingMs = deadlineMs - Date.now();
          if (nextRemainingMs <= 0) {
            throw new Error(`Request timed out after ${timeoutMs}ms: ${resolvedNext}`);
          }
          validated = await validateHop(resolvedNext, Math.max(1, nextRemainingMs));
          currentUrl = validated.url.toString();
          continue;
        }

        if (!res.ok) {
          try {
            await res.body?.cancel();
          } catch {
            // ignore
          }
          throw new Error(`Failed to fetch URL with HTTP ${res.status}: ${currentUrl}`);
        }

        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        const binaryTypes = [
          'image/',
          'audio/',
          'video/',
          'font/',
          'application/pdf',
          'application/octet-stream',
          'application/zip',
          'application/gzip',
          'application/x-tar',
          'application/x-msdownload',
        ];
        if (binaryTypes.some((t) => contentType.includes(t))) {
          try {
            await res.body?.cancel();
          } catch {
            // ignore
          }
          throw new Error(`Unsupported binary content type: "${contentType}"`);
        }

        let bodyText = '';
        let truncatedByBytes = false;
        if (res.body && typeof res.body.getReader === 'function') {
          const reader = res.body.getReader();
          const chunks: Uint8Array[] = [];
          let totalBytes = 0;
          let readFinished = false;
          try {
            while (true) {
              if (context.abortSignal?.aborted) {
                throw new Error('Request aborted');
              }
              const { done, value } = await raceStreamStep(reader.read());
              if (done) {
                readFinished = true;
                break;
              }
              if (value) {
                totalBytes += value.length;
                if (totalBytes > maxBytes) {
                  truncatedByBytes = true;
                  const allowed = maxBytes - (totalBytes - value.length);
                  if (allowed > 0) chunks.push(value.subarray(0, allowed));
                  break;
                }
                chunks.push(value);
              }
            }
          } finally {
            if (!readFinished) {
              try {
                await reader.cancel();
              } catch {
                // ignore
              }
            }
          }
          const combined = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
          let offset = 0;
          for (const c of chunks) {
            combined.set(c, offset);
            offset += c.length;
          }
          bodyText = new TextDecoder('utf-8', { fatal: false }).decode(combined);
          if (truncatedByBytes && bodyText.endsWith('\uFFFD')) {
            bodyText = bodyText.slice(0, -1);
          }
        } else {
          bodyText = await raceStreamStep(res.text());
          if (bodyText.length > maxBytes) {
            truncatedByBytes = true;
            bodyText = bodyText.slice(0, maxBytes);
          }
        }

        let title: string | undefined;
        let content: string;
        if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
          const extracted = htmlToReadableText(bodyText);
          title = extracted.title;
          content = extracted.text;
        } else {
          content = bodyText.trim();
        }

        const truncated = truncatedByBytes || content.length > maxChars;
        if (content.length > maxChars) {
          content = content.slice(0, maxChars);
        }

        return {
          url: currentUrl,
          title,
          content,
          truncated,
        };
      } catch (err: unknown) {
        if (context.abortSignal?.aborted) {
          throw new Error('Request aborted');
        }
        if (timeoutController.signal.aborted) {
          throw new Error(`Request timed out after ${timeoutMs}ms: ${currentUrl}`);
        }
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error(`Request timed out after ${timeoutMs}ms: ${currentUrl}`);
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
        if (context.abortSignal) {
          context.abortSignal.removeEventListener('abort', abortHandler);
        }
      }
    }
  }

  /**
   * Tool 3: resolve_and_standardize_place via Google Places API (New).
   */
  public async resolveAndStandardizePlace(
    args: Record<string, unknown>,
    context: ScoutToolExecutionContext
  ): Promise<{
    query: string;
    places: ResolvedPlaceRecord[];
    best_match: ResolvedPlaceRecord | null;
  }> {
    const rawQuery = typeof args.query === 'string' ? args.query.trim() : '';
    if (!rawQuery) {
      throw new Error('Missing required "query" argument for resolve_and_standardize_place');
    }

    const hasLat = args.lat !== undefined && args.lat !== null;
    const hasLng = args.lng !== undefined && args.lng !== null;
    if (hasLat !== hasLng) {
      throw new Error('Both "lat" and "lng" must be provided together for geographic biasing');
    }

    if (hasLat && hasLng) {
      if (
        typeof args.lat !== 'number' ||
        !Number.isFinite(args.lat) ||
        args.lat < -90 ||
        args.lat > 90 ||
        typeof args.lng !== 'number' ||
        !Number.isFinite(args.lng) ||
        args.lng < -180 ||
        args.lng > 180
      ) {
        throw new Error('Invalid lat/lng for resolve_and_standardize_place: must be finite numbers in [-90, 90] and [-180, 180]');
      }
    }

    if (args.radius_miles !== undefined && args.radius_miles !== null) {
      if (typeof args.radius_miles !== 'number' || !Number.isFinite(args.radius_miles) || args.radius_miles <= 0) {
        throw new Error('Invalid radius_miles for resolve_and_standardize_place: must be a positive finite number');
      }
    }

    const apiKey = await this.resolveGooglePlacesApiKey(context.abortSignal);
    const body: Record<string, unknown> = {
      textQuery: rawQuery,
    };

    if (hasLat && hasLng) {
      const radiusMiles = typeof args.radius_miles === 'number' ? args.radius_miles : 15;
      const clampedRadiusMeters = Math.min(50_000, Math.max(100, Math.round(radiusMiles * 1609.344)));
      body.locationBias = {
        circle: {
          center: { latitude: args.lat as number, longitude: args.lng as number },
          radius: clampedRadiusMeters,
        },
      };
    }

    const data = await this.fetchJsonWithTimeout<RawGooglePlacesTextSearchResponse>(
      GOOGLE_PLACES_TEXT_SEARCH_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': GOOGLE_PLACES_FIELD_MASK,
        },
        body: JSON.stringify(body),
      },
      'Google Places API',
      context.abortSignal
    );

    const rawPlaces = Array.isArray(data.places) ? data.places.slice(0, 5) : [];
    const records: ResolvedPlaceRecord[] = [];

    for (const place of rawPlaces) {
      if (
        !place.location ||
        typeof place.location.latitude !== 'number' ||
        !Number.isFinite(place.location.latitude) ||
        place.location.latitude < -90 ||
        place.location.latitude > 90 ||
        typeof place.location.longitude !== 'number' ||
        !Number.isFinite(place.location.longitude) ||
        place.location.longitude < -180 ||
        place.location.longitude > 180
      ) {
        continue;
      }

      const rawDisplayName = place.displayName?.text?.trim() || '';
      const display_name = rawDisplayName || rawQuery;
      const cleaned = cleanPlaceName(display_name);
      const place_name = cleaned || display_name;
      const address = place.formattedAddress?.trim() || '';
      const lat = Number(place.location.latitude.toFixed(6));
      const lng = Number(place.location.longitude.toFixed(6));
      const trimmedId = typeof place.id === 'string' ? place.id.trim() : '';
      const google_place_id = trimmedId && isValidGooglePlaceId(trimmedId) ? trimmedId : undefined;
      const types = Array.isArray(place.types)
        ? place.types.filter((t): t is string => typeof t === 'string')
        : undefined;
      const weekday_descriptions = Array.isArray(place.regularOpeningHours?.weekdayDescriptions)
        ? place.regularOpeningHours!.weekdayDescriptions.filter((d): d is string => typeof d === 'string')
        : undefined;

      const record: ResolvedPlaceRecord = {
        query: rawQuery,
        place_name,
        display_name,
        address,
        lat,
        lng,
        google_place_id,
        types,
        weekday_descriptions,
      };
      records.push(record);
    }

    if (context.groundingCache && records.length > 0) {
      // Cache primary best_match and any secondary candidates whose place_name explicitly matches the query
      const queryClean = cleanPlaceName(rawQuery).toLowerCase();
      for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        const recNameLower = rec.place_name.toLowerCase();
        if (i === 0 || (queryClean.length >= 3 && (queryClean.includes(recNameLower) || recNameLower.includes(queryClean)))) {
          context.groundingCache.resolvedPlaces.push(rec);
          if (rec.google_place_id) {
            context.groundingCache.knownPlaceIds.add(rec.google_place_id);
          }
        }
      }
    }

    return {
      query: rawQuery,
      places: records,
      best_match: records[0] ?? null,
    };
  }

  /**
   * Tool 4: snap_to_highway_corridor via OSRM nearest.
   */
  public async snapToHighwayCorridor(
    args: Record<string, unknown>,
    context: ScoutToolExecutionContext
  ): Promise<{
    snapped_lat: number;
    snapped_lng: number;
    snapped_road_name: string;
    distance_from_input_meters: number;
    distance_from_input_miles: number;
    road_name_matched?: boolean;
    candidates: Array<{
      lat: number;
      lng: number;
      road_name: string;
      distance_meters: number;
    }>;
  }> {
    if (typeof args.lat !== 'number' || !Number.isFinite(args.lat) || args.lat < -90 || args.lat > 90) {
      throw new Error('Invalid or out-of-bounds latitude [-90, 90]');
    }
    if (typeof args.lng !== 'number' || !Number.isFinite(args.lng) || args.lng < -180 || args.lng > 180) {
      throw new Error('Invalid or out-of-bounds longitude [-180, 180]');
    }

    const baseUrl = this.options.osrmNearestBaseUrl ?? OSRM_NEAREST_BASE_URL;
    const coordSegment = `${Number(args.lng.toFixed(6))},${Number(args.lat.toFixed(6))}`;
    // Preserve literal comma in OSRM URL path (Rule 5)
    const url = `${baseUrl}/${coordSegment}?number=5`;

    const data = await this.fetchJsonWithTimeout<RawOsrmNearestResponse>(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      },
      'OSRM nearest',
      context.abortSignal
    );

    if (data.code !== 'Ok' || !Array.isArray(data.waypoints) || data.waypoints.length === 0) {
      throw new Error('OSRM nearest returned no highway candidates');
    }

    const roadName = typeof args.road_name === 'string' ? args.road_name.trim() : '';
    let selected = data.waypoints[0];
    let road_name_matched: boolean | undefined = undefined;

    if (roadName) {
      const matched = data.waypoints.find((wp) => matchesHighwayRoadName(wp.name || '', roadName));
      if (matched) {
        selected = matched;
        road_name_matched = true;
      } else {
        road_name_matched = false;
      }
    }

    return {
      snapped_lat: Number(selected.location[1].toFixed(6)),
      snapped_lng: Number(selected.location[0].toFixed(6)),
      snapped_road_name: selected.name || '',
      distance_from_input_meters: Math.round(selected.distance ?? 0),
      distance_from_input_miles: Number(((selected.distance ?? 0) / 1609.344).toFixed(3)),
      road_name_matched,
      candidates: data.waypoints.map((wp) => ({
        lat: Number(wp.location[1].toFixed(6)),
        lng: Number(wp.location[0].toFixed(6)),
        road_name: wp.name || '',
        distance_meters: Math.round(wp.distance ?? 0),
      })),
    };
  }

  /**
   * Tool 5: calculate_detour_impact via RouteService.
   */
  public async calculateDetourImpact(
    args: Record<string, unknown>,
    context: ScoutToolExecutionContext
  ): Promise<{
    after_waypoint_id: string;
    preceding_waypoint_id: string;
    following_waypoint_id?: string;
    baseline_leg_miles: number;
    baseline_leg_minutes: number;
    detour_leg_miles: number;
    detour_leg_minutes: number;
    added_distance_miles: number;
    added_duration_minutes: number;
  }> {
    if (
      typeof args.candidate_lat !== 'number' ||
      !Number.isFinite(args.candidate_lat) ||
      args.candidate_lat < -90 ||
      args.candidate_lat > 90
    ) {
      throw new Error('Invalid or out-of-bounds candidate_lat [-90, 90]');
    }
    if (
      typeof args.candidate_lng !== 'number' ||
      !Number.isFinite(args.candidate_lng) ||
      args.candidate_lng < -180 ||
      args.candidate_lng > 180
    ) {
      throw new Error('Invalid or out-of-bounds candidate_lng [-180, 180]');
    }
    const afterId = typeof args.after_waypoint_id === 'string' ? args.after_waypoint_id.trim() : '';
    if (!afterId) {
      throw new Error('Missing required "after_waypoint_id" argument');
    }

    const waypoints = context.tripContext?.waypoints;
    if (!Array.isArray(waypoints) || waypoints.length === 0) {
      throw new Error('Trip context contains no waypoints');
    }

    const idx = waypoints.findIndex((w) => w.id === afterId);
    if (idx === -1) {
      throw new Error(
        `Waypoint "${afterId}" not found in active trip context. Available IDs: ${waypoints.map((w) => w.id).join(', ')}`
      );
    }

    const routeService = this.options.routeService ?? defaultRouteService;
    const prevWp = waypoints[idx];
    const candLng = Number(args.candidate_lng.toFixed(6));
    const candLat = Number(args.candidate_lat.toFixed(6));

    if (idx < waypoints.length - 1) {
      const nextWp = waypoints[idx + 1];
      const [baseRoute, detourRoute] = await Promise.all([
        routeService.getRoute(
          `${Number(prevWp.lng.toFixed(6))},${Number(prevWp.lat.toFixed(6))};${Number(nextWp.lng.toFixed(6))},${Number(nextWp.lat.toFixed(6))}`,
          undefined,
          context.abortSignal
        ),
        routeService.getRoute(
          `${Number(prevWp.lng.toFixed(6))},${Number(prevWp.lat.toFixed(6))};${candLng},${candLat};${Number(nextWp.lng.toFixed(6))},${Number(nextWp.lat.toFixed(6))}`,
          undefined,
          context.abortSignal
        ),
      ]);

      const added_distance_miles = Number((detourRoute.distanceMiles - baseRoute.distanceMiles).toFixed(2));
      const added_duration_minutes = Number((detourRoute.durationMinutes - baseRoute.durationMinutes).toFixed(1));

      return {
        after_waypoint_id: afterId,
        preceding_waypoint_id: prevWp.id,
        following_waypoint_id: nextWp.id,
        baseline_leg_miles: baseRoute.distanceMiles,
        baseline_leg_minutes: baseRoute.durationMinutes,
        detour_leg_miles: detourRoute.distanceMiles,
        detour_leg_minutes: detourRoute.durationMinutes,
        added_distance_miles,
        added_duration_minutes,
      };
    }

    // Appending after final stop
    const legRoute = await routeService.getRoute(
      `${Number(prevWp.lng.toFixed(6))},${Number(prevWp.lat.toFixed(6))};${candLng},${candLat}`,
      undefined,
      context.abortSignal
    );

    return {
      after_waypoint_id: afterId,
      preceding_waypoint_id: prevWp.id,
      following_waypoint_id: undefined,
      baseline_leg_miles: 0,
      baseline_leg_minutes: 0,
      detour_leg_miles: legRoute.distanceMiles,
      detour_leg_minutes: legRoute.durationMinutes,
      added_distance_miles: legRoute.distanceMiles,
      added_duration_minutes: legRoute.durationMinutes,
    };
  }

  /**
   * Tool 6: simulate_schedule_cascade forward cascade and sunset warnings.
   */
  public async simulateScheduleCascade(
    args: Record<string, unknown>,
    context: ScoutToolExecutionContext
  ): Promise<{
    action: string;
    target_waypoint_id: string;
    start_time: string;
    end_time: string;
    total_drive_minutes: number;
    total_dwell_minutes: number;
    total_distance_miles: number;
    timezones_crossed: string[];
    sunset_warnings: Array<{
      id: string;
      name: string;
      arrival_time: string;
      timezone: string;
    }>;
    stops: Array<{
      id: string;
      name: string;
      type: string;
      lat: number;
      lng: number;
      arrival_time: string;
      departure_time: string;
      dwell_minutes: number;
      drive_minutes_from_previous: number;
      distance_miles_from_previous: number;
      timezone: string;
    }>;
  }> {
    const action = typeof args.action === 'string' ? args.action.trim() : '';
    if (action !== 'add' && action !== 'update' && action !== 'delete') {
      throw new Error('Invalid action: must be "add", "update", or "delete"');
    }

    const targetId = typeof args.target_waypoint_id === 'string' ? args.target_waypoint_id.trim() : '';
    if (!targetId) {
      throw new Error('Missing required "target_waypoint_id" argument');
    }

    if (args.dwell_minutes !== undefined && args.dwell_minutes !== null) {
      if (typeof args.dwell_minutes !== 'number' || !Number.isFinite(args.dwell_minutes) || args.dwell_minutes < 0) {
        throw new Error('Invalid dwell_minutes: must be a non-negative finite number');
      }
    }

    const originalWaypoints = context.tripContext?.waypoints;
    if (!Array.isArray(originalWaypoints)) {
      throw new Error('Trip context waypoints must be an array');
    }

    interface SimulationWaypoint extends ScoutWaypointSummary {
      origIndex?: number;
    }

    const waypoints: SimulationWaypoint[] = originalWaypoints.map((w, index) => ({ ...w, origIndex: index }));
    const idx = waypoints.findIndex((w) => w.id === targetId);
    if (idx === -1) {
      throw new Error(
        `Target waypoint "${targetId}" not found in active trip context. Available IDs: ${waypoints.map((w) => w.id).join(', ')}`
      );
    }

    if (action === 'add') {
      if (
        typeof args.candidate_lat !== 'number' ||
        !Number.isFinite(args.candidate_lat) ||
        args.candidate_lat < -90 ||
        args.candidate_lat > 90
      ) {
        throw new Error('Missing or invalid candidate_lat [-90, 90] for action "add"');
      }
      if (
        typeof args.candidate_lng !== 'number' ||
        !Number.isFinite(args.candidate_lng) ||
        args.candidate_lng < -180 ||
        args.candidate_lng > 180
      ) {
        throw new Error('Missing or invalid candidate_lng [-180, 180] for action "add"');
      }
      const candidateName =
        typeof args.candidate_name === 'string' && args.candidate_name.trim()
          ? args.candidate_name.trim()
          : 'Candidate Stop';
      const candidateType =
        typeof args.candidate_type === 'string' && args.candidate_type.trim()
          ? args.candidate_type.trim()
          : 'scenic_pull_off';
      const dwell = typeof args.dwell_minutes === 'number' ? args.dwell_minutes : 15;

      const newWp: SimulationWaypoint = {
        id: `sim_add_${Date.now()}`,
        name: candidateName,
        type: candidateType,
        lat: Number(args.candidate_lat.toFixed(6)),
        lng: Number(args.candidate_lng.toFixed(6)),
        dwell_minutes: dwell,
        origIndex: undefined,
      };
      waypoints.splice(idx + 1, 0, newWp);
    } else if (action === 'update') {
      const existing = waypoints[idx];
      const hasCandLat = args.candidate_lat !== undefined && args.candidate_lat !== null;
      const hasCandLng = args.candidate_lng !== undefined && args.candidate_lng !== null;
      if (hasCandLat !== hasCandLng) {
        throw new Error('Both "candidate_lat" and "candidate_lng" must be provided together when updating coordinates');
      }
      if (hasCandLat && hasCandLng) {
        if (
          typeof args.candidate_lat !== 'number' ||
          !Number.isFinite(args.candidate_lat) ||
          args.candidate_lat < -90 ||
          args.candidate_lat > 90 ||
          typeof args.candidate_lng !== 'number' ||
          !Number.isFinite(args.candidate_lng) ||
          args.candidate_lng < -180 ||
          args.candidate_lng > 180
        ) {
          throw new Error('Invalid candidate_lat/candidate_lng for action "update": must be finite numbers in [-90, 90] and [-180, 180]');
        }
        existing.lat = Number((args.candidate_lat as number).toFixed(6));
        existing.lng = Number((args.candidate_lng as number).toFixed(6));
      }
      if (typeof args.dwell_minutes === 'number') {
        existing.dwell_minutes = args.dwell_minutes;
      }
      if (typeof args.candidate_name === 'string' && args.candidate_name.trim()) {
        existing.name = args.candidate_name.trim();
      }
      if (typeof args.candidate_type === 'string' && args.candidate_type.trim()) {
        existing.type = args.candidate_type.trim();
      }
    } else if (action === 'delete') {
      waypoints.splice(idx, 1);
    }

    if (waypoints.length === 0) {
      return {
        action,
        target_waypoint_id: targetId,
        start_time: '08:00',
        end_time: '08:00',
        total_drive_minutes: 0,
        total_dwell_minutes: 0,
        total_distance_miles: 0,
        timezones_crossed: [],
        sunset_warnings: [],
        stops: [],
      };
    }

    const departureTimeStr = (context.tripContext.departureTime || '08:00:00').trim();
    if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(departureTimeStr)) {
      throw new Error(`Invalid departureTime format "${departureTimeStr}": expected "HH:mm" or "HH:mm:ss"`);
    }

    const tripDate = (context.tripContext.date || '2026-10-10').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tripDate)) {
      throw new Error(`Invalid trip date format "${tripDate}": expected "YYYY-MM-DD"`);
    }

    const resolveValidTimezone = (wp: ScoutWaypointSummary): string => {
      if (wp.timezone && typeof wp.timezone === 'string') {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: wp.timezone });
          return wp.timezone;
        } catch {
          throw new Error(`Invalid IANA timezone "${wp.timezone}" on waypoint "${wp.id}"`);
        }
      }
      return detectTimezone(wp.lat, wp.lng);
    };

    const originTz = resolveValidTimezone(waypoints[0]);

    // Compute start epoch
    const [depH = '08', depM = '00', depS = '00'] = departureTimeStr.split(':');
    const [yearStr = '2026', monthStr = '10', dayStr = '10'] = tripDate.split('-');
    const hNum = parseInt(depH, 10);
    const mNum = parseInt(depM, 10);
    const sNum = parseInt(depS, 10);
    if (hNum < 0 || hNum > 23 || mNum < 0 || mNum > 59 || sNum < 0 || sNum > 59) {
      throw new Error(`Departure time out of bounds: "${departureTimeStr}"`);
    }

    let currentEpoch = Date.UTC(
      parseInt(yearStr, 10),
      parseInt(monthStr, 10) - 1,
      parseInt(dayStr, 10),
      hNum,
      mNum,
      sNum
    );

    // Refine start epoch to origin timezone
    const originFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: originTz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    for (let iter = 0; iter < 3; iter++) {
      const partsMap: Record<string, string> = {};
      for (const p of originFormatter.formatToParts(new Date(currentEpoch))) {
        partsMap[p.type] = p.value;
      }
      let ph = partsMap.hour || '00';
      if (ph === '24') ph = '00';
      const actualNaive = Date.UTC(
        parseInt(partsMap.year || '2026', 10),
        parseInt(partsMap.month || '10', 10) - 1,
        parseInt(partsMap.day || '10', 10),
        parseInt(ph, 10),
        parseInt(partsMap.minute || '00', 10),
        parseInt(partsMap.second || '00', 10)
      );
      const targetNaive = Date.UTC(
        parseInt(yearStr, 10),
        parseInt(monthStr, 10) - 1,
        parseInt(dayStr, 10),
        hNum,
        mNum,
        sNum
      );
      const diff = actualNaive - targetNaive;
      if (diff === 0) break;
      currentEpoch -= diff;
    }

    const timezonesSet = new Set<string>();
    const sunsetWarnings: Array<{ id: string; name: string; arrival_time: string; timezone: string }> = [];
    const stops: Array<{
      id: string;
      name: string;
      type: string;
      lat: number;
      lng: number;
      arrival_time: string;
      departure_time: string;
      dwell_minutes: number;
      drive_minutes_from_previous: number;
      distance_miles_from_previous: number;
      timezone: string;
    }> = [];

    const routeService = this.options.routeService ?? defaultRouteService;

    interface LegMeasurement {
      distMiles: number;
      driveSec: number;
    }

    const legMeasurements: LegMeasurement[] = new Array(waypoints.length);
    const legRoutingTasks: Array<{ legIdx: number; promise: Promise<LegMeasurement> }> = [];

    for (let i = 1; i < waypoints.length; i++) {
      const prev = waypoints[i - 1];
      const wp = waypoints[i];
      const isUnchanged =
        prev.origIndex !== undefined &&
        wp.origIndex !== undefined &&
        wp.origIndex === prev.origIndex + 1 &&
        Math.abs(originalWaypoints[prev.origIndex].lat - prev.lat) < 1e-6 &&
        Math.abs(originalWaypoints[prev.origIndex].lng - prev.lng) < 1e-6 &&
        Math.abs(originalWaypoints[wp.origIndex].lat - wp.lat) < 1e-6 &&
        Math.abs(originalWaypoints[wp.origIndex].lng - wp.lng) < 1e-6 &&
        typeof wp.drive_duration_minutes === 'number' &&
        Number.isFinite(wp.drive_duration_minutes) &&
        wp.drive_duration_minutes >= 0 &&
        typeof wp.drive_distance_miles === 'number' &&
        Number.isFinite(wp.drive_distance_miles) &&
        wp.drive_distance_miles >= 0;

      if (isUnchanged) {
        legMeasurements[i] = {
          distMiles: wp.drive_distance_miles as number,
          driveSec: Math.round((wp.drive_duration_minutes as number) * 60),
        };
      } else {
        const coordString = `${Number(prev.lng.toFixed(6))},${Number(prev.lat.toFixed(6))};${Number(wp.lng.toFixed(6))},${Number(wp.lat.toFixed(6))}`;
        legRoutingTasks.push({
          legIdx: i,
          promise: (async () => {
            const routeRes = await routeService.getRoute(coordString, undefined, context.abortSignal);
            const distMiles = routeRes.distanceMiles;
            const driveSec =
              typeof routeRes.durationSeconds === 'number' && Number.isFinite(routeRes.durationSeconds)
                ? routeRes.durationSeconds
                : Math.round(routeRes.durationMinutes * 60);
            return { distMiles, driveSec };
          })(),
        });
      }
    }

    if (legRoutingTasks.length > 0) {
      const taskResults = await Promise.all(legRoutingTasks.map((t) => t.promise));
      for (let t = 0; t < legRoutingTasks.length; t++) {
        legMeasurements[legRoutingTasks[t].legIdx] = taskResults[t];
      }
    }

    let totalDriveSeconds = 0;
    let totalDwellMinutes = 0;
    let totalDistanceMiles = 0;

    for (let i = 0; i < waypoints.length; i++) {
      const wp = waypoints[i];
      const tz = resolveValidTimezone(wp);
      timezonesSet.add(tz);

      let driveSec = 0;
      let distMiles = 0;

      if (i > 0) {
        const leg = legMeasurements[i];
        distMiles = leg.distMiles;
        driveSec = leg.driveSec;
        totalDriveSeconds += driveSec;
        totalDistanceMiles += distMiles;
      }

      currentEpoch += driveSec * 1000;
      const arrivalEpoch = currentEpoch;

      const stopFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });

      const arrivalParts: Record<string, string> = {};
      for (const p of stopFormatter.formatToParts(new Date(arrivalEpoch))) {
        arrivalParts[p.type] = p.value;
      }
      let arrH = arrivalParts.hour || '00';
      if (arrH === '24') arrH = '00';
      const arrM = arrivalParts.minute || '00';
      const arrivalTime = `${arrH}:${arrM}`;

      const hourNum = parseInt(arrH, 10);
      const minNum = parseInt(arrM, 10);
      if (hourNum > 18 || (hourNum === 18 && minNum >= 30)) {
        sunsetWarnings.push({
          id: wp.id,
          name: wp.name,
          arrival_time: arrivalTime,
          timezone: tz,
        });
      }

      const isLast = i === waypoints.length - 1;
      const isOvernightOrFinalDest = isLast && (wp.type === 'lodging' || wp.type === 'destination');
      const dwell = isOvernightOrFinalDest ? 0 : Math.max(0, wp.dwell_minutes ?? 0);
      totalDwellMinutes += dwell;
      currentEpoch += dwell * 60 * 1000;
      const departureEpoch = currentEpoch;

      const depParts: Record<string, string> = {};
      for (const p of stopFormatter.formatToParts(new Date(departureEpoch))) {
        depParts[p.type] = p.value;
      }
      let dH = depParts.hour || '00';
      if (dH === '24') dH = '00';
      const dM = depParts.minute || '00';
      const departureTime = `${dH}:${dM}`;

      stops.push({
        id: wp.id,
        name: wp.name,
        type: wp.type,
        lat: wp.lat,
        lng: wp.lng,
        arrival_time: arrivalTime,
        departure_time: departureTime,
        dwell_minutes: dwell,
        drive_minutes_from_previous: Number((driveSec / 60).toFixed(1)),
        distance_miles_from_previous: Number(distMiles.toFixed(2)),
        timezone: tz,
      });
    }

    return {
      action,
      target_waypoint_id: targetId,
      start_time: stops[0]?.departure_time || '08:00',
      end_time: stops[stops.length - 1]?.arrival_time || '08:00',
      total_drive_minutes: Number((totalDriveSeconds / 60).toFixed(1)),
      total_dwell_minutes: totalDwellMinutes,
      total_distance_miles: Number(totalDistanceMiles.toFixed(2)),
      timezones_crossed: Array.from(timezonesSet),
      sunset_warnings: sunsetWarnings,
      stops,
    };
  }

  /**
   * Tool 7: audit_corridor_waypoints via OSRM nearest and structural checks.
   */
  public async auditCorridorWaypoints(
    args: Record<string, unknown>,
    context: ScoutToolExecutionContext
  ): Promise<{
    waypoint_count: number;
    flagged_count: number;
    waypoints: Array<{
      id: string;
      name: string;
      type: string;
      lat: number;
      lng: number;
      distance_from_road_meters: number;
      nearest_road_name: string;
      issues: string[];
    }>;
  }> {
    if (args.day_number !== undefined && args.day_number !== null) {
      if (typeof args.day_number !== 'number' || !Number.isInteger(args.day_number) || args.day_number < 1) {
        throw new Error('Invalid day_number for audit_corridor_waypoints: must be a positive integer');
      }
      if (
        context.scope?.type === 'day' &&
        typeof context.scope.dayNumber === 'number' &&
        args.day_number !== context.scope.dayNumber
      ) {
        throw new Error(
          `Requested day_number ${args.day_number} does not match active scope Day ${context.scope.dayNumber}`
        );
      }
    }

    const waypoints = context.tripContext?.waypoints;
    if (!Array.isArray(waypoints)) {
      throw new Error('Trip context waypoints must be an array');
    }
    if (waypoints.length > MAX_AUDIT_WAYPOINTS) {
      throw new Error(`Corridor audit exceeds maximum waypoint limit (${MAX_AUDIT_WAYPOINTS})`);
    }

    for (let i = 0; i < waypoints.length; i++) {
      const wp = waypoints[i];
      if (!wp || typeof wp.id !== 'string' || !wp.id.trim() || typeof wp.name !== 'string') {
        throw new Error(`Invalid waypoint metadata at index ${i}`);
      }
      if (
        typeof wp.lat !== 'number' ||
        !Number.isFinite(wp.lat) ||
        wp.lat < -90 ||
        wp.lat > 90 ||
        typeof wp.lng !== 'number' ||
        !Number.isFinite(wp.lng) ||
        wp.lng < -180 ||
        wp.lng > 180
      ) {
        throw new Error(`Invalid coordinates on waypoint "${wp.id}": lat/lng must be finite numbers in bounds`);
      }
    }

    const baseUrl = this.options.osrmNearestBaseUrl ?? OSRM_NEAREST_BASE_URL;
    const auditResults = new Array<{
      id: string;
      name: string;
      type: string;
      lat: number;
      lng: number;
      distance_from_road_meters: number;
      nearest_road_name: string;
      issues: string[];
    }>(waypoints.length);

    let nextIndex = 0;
    const workerCount = Math.min(MAX_AUDIT_CONCURRENCY, Math.max(1, waypoints.length));

    const auditSingleWaypoint = async (wp: ScoutWaypointSummary) => {
      const coordSegment = `${Number(wp.lng.toFixed(6))},${Number(wp.lat.toFixed(6))}`;
      const url = `${baseUrl}/${coordSegment}?number=1`;
      const data = await this.fetchJsonWithTimeout<RawOsrmNearestResponse>(
        url,
        {
          method: 'GET',
          headers: { Accept: 'application/json' },
        },
        'OSRM nearest',
        context.abortSignal
      );

      if (data.code !== 'Ok' || !Array.isArray(data.waypoints) || data.waypoints.length === 0) {
        throw new Error('OSRM nearest returned no highway candidates');
      }

      const distanceFromRoadMeters = Math.round(data.waypoints[0].distance ?? 0);
      const nearestRoadName = data.waypoints[0].name || '';

      const issues: string[] = [];

      // 1. Off-highway drive-by
      const isDriveBy = wp.type === 'scenic_drive_by' || (wp.dwell_minutes === 0 && Boolean(wp.is_route_anchor));
      if (isDriveBy && distanceFromRoadMeters > 75) {
        issues.push(
          `off_highway_drive_by: placed ${distanceFromRoadMeters}m from nearest road "${nearestRoadName || 'unknown'}" (must be <= 75m directly on highway)`
        );
      }

      // 2. Low leg speed anomaly (< 30 mph over >= 2 miles)
      if (
        wp.drive_distance_miles !== undefined &&
        wp.drive_distance_miles >= 2 &&
        wp.drive_speed_mph !== undefined &&
        wp.drive_speed_mph < 30
      ) {
        issues.push(
          `low_leg_speed_anomaly: average speed ${wp.drive_speed_mph} mph over ${wp.drive_distance_miles} miles indicates off-highway dirt road detour`
        );
      }

      // 3. Invalid Google Place ID
      if (typeof wp.google_place_id === 'string' && wp.google_place_id.trim().length > 0) {
        if (!isValidGooglePlaceId(wp.google_place_id)) {
          issues.push(`invalid_google_place_id: "${wp.google_place_id}" failed binary protobuf structural validation`);
        }
      }

      // 4. Physical stop checks
      const isPhysical =
        wp.type === 'meal' ||
        wp.type === 'fuel' ||
        wp.type === 'lodging' ||
        (wp.type === 'scenic_pull_off' && (wp.dwell_minutes ?? 0) > 0);

      if (isPhysical) {
        if (!wp.address || !wp.place_name) {
          issues.push('missing_physical_stop_metadata: physical stops require verified place_name and street address');
        }
        if (wp.is_route_anchor === true) {
          issues.push('invalid_route_anchor_on_physical_stop: physical stops must have is_route_anchor: false');
        }
      }

      // 5. Speech copy tense
      if (wp.notification?.speech) {
        if (/\b(?:now cruising|currently passing|currently driving)\b/i.test(wp.notification.speech) || /^(?:driving past|passing by)\b/i.test(wp.notification.speech.trim())) {
          issues.push('non_anticipatory_speech: proximity alerts must use anticipatory future phrasing');
        }
      }

      // 6. ID / Purpose category mismatch (using word-boundary tokens so "Las Vegas" never matches "gas")
      const idTokens = wp.id.toLowerCase().replace(/_/g, ' ');
      const speechLower = wp.notification?.speech?.toLowerCase() || '';
      const hasFuelToken = /\b(?:fuel|gas|gasoline|petrol)\b/.test(idTokens) || /\b(?:fuel|gas|gasoline|petrol)\b/.test(speechLower);
      const hasMealToken = /\b(?:meal|lunch|dinner|breakfast)\b/.test(idTokens);
      if (hasFuelToken && wp.type === 'meal') {
        issues.push('category_notification_mismatch: waypoint type is "meal" but id or speech refers to fuel');
      } else if (hasMealToken && wp.type === 'fuel') {
        issues.push('category_notification_mismatch: waypoint type is "fuel" but id refers to meal/lunch');
      }

      return {
        id: wp.id,
        name: wp.name,
        type: wp.type,
        lat: wp.lat,
        lng: wp.lng,
        distance_from_road_meters: distanceFromRoadMeters,
        nearest_road_name: nearestRoadName,
        issues,
      };
    };

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (nextIndex < waypoints.length) {
          if (context.abortSignal?.aborted) {
            throw new Error('Request aborted');
          }
          const idx = nextIndex++;
          auditResults[idx] = await auditSingleWaypoint(waypoints[idx]);
        }
      })
    );

    const flaggedList = auditResults.filter((w) => w.issues.length > 0);

    return {
      waypoint_count: waypoints.length,
      flagged_count: flaggedList.length,
      waypoints: auditResults,
    };
  }
}
