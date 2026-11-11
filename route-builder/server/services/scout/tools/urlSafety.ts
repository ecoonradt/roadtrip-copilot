import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import {
  MAX_READ_URL_BYTES,
  MAX_READ_URL_CHARS,
  MAX_REDIRECT_HOPS,
  READ_URL_TIMEOUT_MS,
  type DnsLookupFn,
  type SafeUrlValidationResult,
  type DnsValidationOptions,
} from './types.js';

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

const ALLOWED_EXTERNAL_PORTS = new Set(['', '80', '443']);

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

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Dispatches an HTTP/HTTPS request using a pinned, pre-validated IP address to prevent DNS rebinding.
 */
export function requestPinnedUrl(
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
    let responseDelivered = false;
    let streamDone = false;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    let incomingRef: http.IncomingMessage | null = null;
    let decompressorRef: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null = null;
    let bodyStreamRef: NodeJS.ReadableStream | null = null;
    let reqRef: http.ClientRequest | null = null;

    function finalizeOwnedResources(): void {
      const decompressor = decompressorRef;
      const incoming = incomingRef;
      const request = reqRef;
      if (decompressor && !decompressor.destroyed) {
        decompressor.destroy();
      }
      if (incoming && !incoming.destroyed) {
        incoming.destroy();
      }
      if (request && !request.destroyed) {
        request.destroy();
      }
      // Keep error listeners attached: a stream can emit a late 'error' after destroy().
      // The handlers are idempotent and see settled/streamDone, so late failures cannot crash.
      if (bodyStreamRef) {
        bodyStreamRef.removeListener('data', onData);
        bodyStreamRef.removeListener('end', onEnd);
        bodyStreamRef = null;
      }
      decompressorRef = null;
      incomingRef = null;
      reqRef = null;
    }

    function removeAbortListener(): void {
      signal.removeEventListener('abort', onAbort);
    }

    function rejectResponse(err: Error): void {
      if (settled) {
        errorStream(err);
        return;
      }
      settled = true;
      streamDone = true;
      removeAbortListener();
      if (controllerRef) {
        try {
          controllerRef.error(err);
        } catch {
          // The stream controller may already be closed or errored.
        }
        controllerRef = null;
      }
      finalizeOwnedResources();
      reject(err);
    }

    function errorStream(err: Error): void {
      if (streamDone) {
        finalizeOwnedResources();
        return;
      }
      streamDone = true;
      removeAbortListener();
      if (controllerRef) {
        try {
          controllerRef.error(err);
        } catch {
          // The stream controller may already be closed or errored.
        }
        controllerRef = null;
      }
      finalizeOwnedResources();
    }

    function closeStream(): void {
      if (streamDone) return;
      streamDone = true;
      removeAbortListener();
      if (controllerRef) {
        try {
          controllerRef.close();
        } catch {
          // The stream controller may already be closed.
        }
        controllerRef = null;
      }
      finalizeOwnedResources();
    }

    function onAbort(): void {
      const abortError = new Error('Request aborted');
      if (!settled) {
        rejectResponse(abortError);
      } else if (responseDelivered) {
        errorStream(abortError);
      }
    }

    function onData(chunk: Buffer | Uint8Array): void {
      if (streamDone || !controllerRef) return;
      try {
        controllerRef.enqueue(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      } catch (err: unknown) {
        errorStream(new Error(`Failed to enqueue response body chunk: ${describeError(err)}`));
      }
    }

    function onEnd(): void {
      closeStream();
    }

    function onBodyError(err: Error): void {
      if (!settled) {
        rejectResponse(err);
      } else {
        errorStream(err);
      }
    }

    function onIncomingError(err: Error): void {
      if (!settled) {
        rejectResponse(err);
      } else {
        errorStream(err);
      }
    }

    function onRequestError(err: Error): void {
      if (!settled) {
        rejectResponse(err);
      } else {
        errorStream(err);
      }
    }

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

    let req: http.ClientRequest;
    try {
      req = transport.request(reqOptions, (incoming: http.IncomingMessage) => {
        if (settled) {
          incoming.on('error', onIncomingError);
          if (!incoming.destroyed) incoming.destroy();
          return;
        }

        incomingRef = incoming;
        incoming.on('error', onIncomingError);

        let resHeaders: Headers;
        try {
          resHeaders = new Headers();
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
        } catch (err: unknown) {
          rejectResponse(new Error(`Failed to construct response headers: ${describeError(err)}`));
          return;
        }

        const status = incoming.statusCode;
        if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) {
          rejectResponse(
            new Error(
              `Invalid HTTP response status from upstream: ${status === undefined ? 'undefined' : String(status)}`
            )
          );
          return;
        }

        const statusText = typeof incoming.statusMessage === 'string' ? incoming.statusMessage : '';

        // Null-body statuses cannot be paired with a ReadableStream in the Response constructor.
        if (NULL_BODY_STATUSES.has(status)) {
          let response: Response;
          try {
            response = new Response(null, { status, statusText, headers: resHeaders });
          } catch (err: unknown) {
            rejectResponse(new Error(`Failed to construct HTTP ${status} response: ${describeError(err)}`));
            return;
          }
          settled = true;
          responseDelivered = true;
          streamDone = true;
          removeAbortListener();
          resolve(response);
          finalizeOwnedResources();
          return;
        }

        let bodyStream: NodeJS.ReadableStream = incoming;
        const contentEncoding = (resHeaders.get('content-encoding') || '').toLowerCase().trim();
        try {
          if (contentEncoding === 'gzip') {
            const decompressor = zlib.createGunzip();
            decompressorRef = decompressor;
            incoming.pipe(decompressor);
            bodyStream = decompressor;
            resHeaders.delete('content-encoding');
          } else if (contentEncoding === 'deflate') {
            const decompressor = zlib.createInflate();
            decompressorRef = decompressor;
            incoming.pipe(decompressor);
            bodyStream = decompressor;
            resHeaders.delete('content-encoding');
          } else if (contentEncoding === 'br') {
            const decompressor = zlib.createBrotliDecompress();
            decompressorRef = decompressor;
            incoming.pipe(decompressor);
            bodyStream = decompressor;
            resHeaders.delete('content-encoding');
          }
        } catch (err: unknown) {
          rejectResponse(new Error(`Failed to initialize response decompressor: ${describeError(err)}`));
          return;
        }

        bodyStreamRef = bodyStream;
        let response: Response;
        try {
          const webStream = new ReadableStream<Uint8Array>({
            start(controller) {
              controllerRef = controller;
              bodyStream.on('data', onData);
              bodyStream.on('end', onEnd);
              bodyStream.on('error', onBodyError);
            },
            cancel() {
              if (streamDone) return;
              streamDone = true;
              removeAbortListener();
              controllerRef = null;
              finalizeOwnedResources();
            },
          });
          response = new Response(webStream, {
            status,
            statusText,
            headers: resHeaders,
          });
        } catch (err: unknown) {
          rejectResponse(new Error(`Failed to construct HTTP ${status} response: ${describeError(err)}`));
          return;
        }

        settled = true;
        responseDelivered = true;
        resolve(response);
      });
      reqRef = req;
    } catch (err: unknown) {
      rejectResponse(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    req.on('error', onRequestError);

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

    try {
      req.end();
    } catch (err: unknown) {
      rejectResponse(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export interface ReadUrlContentToolOptions {
  abortSignal?: AbortSignal;
  dnsLookup?: DnsLookupFn;
  urlTimeoutMs?: number;
  maxUrlChars?: number;
  fetchImpl?: typeof fetch;
  fetchWithTimeout?: (
    url: string,
    init: RequestInit,
    abortSignal?: AbortSignal,
    customTimeoutMs?: number
  ) => Promise<Response>;
  requestPinned?: (
    validated: SafeUrlValidationResult,
    headers: Record<string, string>,
    signal: AbortSignal
  ) => Promise<Response>;
}

/**
 * Fetches an external HTTP/HTTPS URL and extracts readable text content.
 * Enforces strict SSRF protection, redirect limits, and size caps.
 */
export async function readUrlContentTool(
  args: Record<string, unknown>,
  options: ReadUrlContentToolOptions
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

  const timeoutMs = options.urlTimeoutMs ?? READ_URL_TIMEOUT_MS;
  const deadlineMs = Date.now() + timeoutMs;
  const maxChars = options.maxUrlChars ?? MAX_READ_URL_CHARS;
  const maxBytes = MAX_READ_URL_BYTES;
  const MAX_REDIRECTS = MAX_REDIRECT_HOPS;
  let redirects = 0;

  const validateHop = async (targetUrl: string, remainingMs: number): Promise<SafeUrlValidationResult> => {
    if (options.dnsLookup || !options.fetchImpl) {
      return await resolveValidatedUrlWithDns(targetUrl, options.dnsLookup, {
        timeoutMs: remainingMs,
        abortSignal: options.abortSignal,
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
    if (options.abortSignal?.aborted) {
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
    if (options.abortSignal) {
      options.abortSignal.addEventListener('abort', abortHandler, { once: true });
    }

    const raceStreamStep = <T>(promise: Promise<T>): Promise<T> => {
      if (timeoutController.signal.aborted) {
        if (options.abortSignal?.aborted) {
          return Promise.reject(new Error('Request aborted'));
        }
        return Promise.reject(new Error(`Request timed out after ${timeoutMs}ms: ${currentUrl}`));
      }
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          if (options.abortSignal?.aborted) {
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
      if (options.fetchImpl) {
        if (options.fetchWithTimeout) {
          res = await options.fetchWithTimeout(
            currentUrl,
            {
              method: 'GET',
              redirect: 'manual',
              headers,
            },
            timeoutController.signal,
            hopTimeoutMs
          );
        } else {
          res = await options.fetchImpl(currentUrl, {
            method: 'GET',
            redirect: 'manual',
            headers,
            signal: timeoutController.signal,
          });
        }
      } else {
        const requestPinnedFn = options.requestPinned ?? requestPinnedUrl;
        res = await requestPinnedFn(validated, headers, timeoutController.signal);
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
            if (options.abortSignal?.aborted) {
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
      if (options.abortSignal?.aborted) {
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
      if (options.abortSignal) {
        options.abortSignal.removeEventListener('abort', abortHandler);
      }
    }
  }
}
