import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';
import { defaultRouteService } from './routeService.js';
import { isValidGooglePlaceId } from './placeId.js';

import {
  BRAVE_SEARCH_BASE_URL,
  GOOGLE_PLACES_TEXT_SEARCH_URL,
  GOOGLE_PLACES_FIELD_MASK,
  OSRM_NEAREST_BASE_URL,
  DEFAULT_BRAVE_SEARCH_SSM_PARAM,
  DEFAULT_GOOGLE_PLACES_SSM_PARAM,
  CONFIG_CACHE_TTL_MS,
  LOAD_RETRY_COOLDOWN_MS,
  type ScoutToolLibraryOptions,
  type ScoutToolExecutionContext,
  type ResolvedPlaceRecord,
  type SafeUrlValidationResult,
} from './scoutTools/types.js';

import {
  requestPinnedUrl,
  readUrlContentTool,
} from './scoutTools/urlSafety.js';

import {
  cleanPlaceName,
} from './scoutTools/geo.js';

import {
  simulateScheduleCascadeTool,
  type ScheduleCascadeResult,
} from './scoutTools/scheduleSimulator.js';

import {
  snapToHighwayCorridorTool,
  calculateDetourImpactTool,
  auditCorridorWaypointsTool,
  type SnapToHighwayCorridorResult,
  type DetourImpactResult,
  type AuditCorridorWaypointsResult,
} from './scoutTools/corridorTools.js';

// Re-export all symbols from submodules for 100% backward compatibility
export * from './scoutTools/types.js';
export * from './scoutTools/urlSafety.js';
export * from './scoutTools/geo.js';
export * from './scoutTools/scheduleSimulator.js';
export * from './scoutTools/corridorTools.js';

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

  public async requestPinnedUrl(
    validated: SafeUrlValidationResult,
    headers: Record<string, string>,
    signal: AbortSignal
  ): Promise<Response> {
    return requestPinnedUrl(validated, headers, signal);
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
    return readUrlContentTool(args, {
      abortSignal: context.abortSignal,
      dnsLookup: this.options.dnsLookup,
      urlTimeoutMs: this.options.urlTimeoutMs,
      maxUrlChars: this.options.maxUrlChars,
      fetchImpl: this.options.fetchImpl,
      fetchWithTimeout: (url, init, signal, customMs) =>
        this.fetchWithTimeout(url, init, signal, customMs),
      requestPinned: (v, h, s) => this.requestPinnedUrl(v, h, s),
    });
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
  ): Promise<SnapToHighwayCorridorResult> {
    const osrmNearestBaseUrl = this.options.osrmNearestBaseUrl ?? OSRM_NEAREST_BASE_URL;
    return snapToHighwayCorridorTool(args, context, {
      osrmNearestBaseUrl,
      fetchJsonWithTimeout: <T>(
        url: string,
        init: RequestInit,
        upstreamLabel: string,
        abortSignal?: AbortSignal,
        customTimeoutMs?: number
      ) => this.fetchJsonWithTimeout<T>(url, init, upstreamLabel, abortSignal, customTimeoutMs),
    });
  }

  /**
   * Tool 5: calculate_detour_impact via RouteService.
   */
  public async calculateDetourImpact(
    args: Record<string, unknown>,
    context: ScoutToolExecutionContext
  ): Promise<DetourImpactResult> {
    const routeService = this.options.routeService ?? defaultRouteService;
    return calculateDetourImpactTool(args, context, routeService);
  }

  /**
   * Tool 6: simulate_schedule_cascade forward cascade and sunset warnings.
   */
  public async simulateScheduleCascade(
    args: Record<string, unknown>,
    context: ScoutToolExecutionContext
  ): Promise<ScheduleCascadeResult> {
    const routeService = this.options.routeService ?? defaultRouteService;
    return simulateScheduleCascadeTool(args, context, routeService);
  }

  /**
   * Tool 7: audit_corridor_waypoints via OSRM nearest and structural checks.
   */
  public async auditCorridorWaypoints(
    args: Record<string, unknown>,
    context: ScoutToolExecutionContext
  ): Promise<AuditCorridorWaypointsResult> {
    const osrmNearestBaseUrl = this.options.osrmNearestBaseUrl ?? OSRM_NEAREST_BASE_URL;
    return auditCorridorWaypointsTool(args, context, {
      osrmNearestBaseUrl,
      fetchJsonWithTimeout: <T>(
        url: string,
        init: RequestInit,
        upstreamLabel: string,
        abortSignal?: AbortSignal,
        customTimeoutMs?: number
      ) => this.fetchJsonWithTimeout<T>(url, init, upstreamLabel, abortSignal, customTimeoutMs),
    });
  }
}

export const defaultScoutToolLibrary = new ScoutToolLibrary();
