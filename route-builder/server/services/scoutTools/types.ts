import type dns from 'node:dns';
import type { SSMClient } from '@aws-sdk/client-ssm';
import type { RouteService } from '../routeService.js';
import type { ToolDeclaration } from '../../types/ai.js';
import type { ScoutScope, ScoutTripContext, ScoutWaypointSummary } from '../../types/scout.js';

export type ScoutToolDeclaration = ToolDeclaration;
export type { ScoutScope, ScoutTripContext, ScoutWaypointSummary };

export const DEFAULT_BRAVE_SEARCH_SSM_PARAM = '/roadtrip-copilot/brave-search-api-key';
export const DEFAULT_GOOGLE_PLACES_SSM_PARAM = '/roadtrip-copilot/google-places-api-key';
export const BRAVE_SEARCH_BASE_URL = 'https://api.search.brave.com/res/v1/web/search';
export const GOOGLE_PLACES_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
export const GOOGLE_PLACES_FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.regularOpeningHours';
export const OSRM_NEAREST_BASE_URL = 'https://router.project-osrm.org/nearest/v1/driving';

export const MAX_READ_URL_BYTES = 512 * 1024;
export const MAX_READ_URL_CHARS = 12_000;
export const MAX_REDIRECT_HOPS = 3;
export const READ_URL_TIMEOUT_MS = 10_000;

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

export type DnsLookupAddress = dns.LookupAddress;

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

export interface HighwayDesignator {
  kind: 'interstate' | 'us' | 'state';
  stateCode?: string;
  number: string;
}

export interface PlaceMatchCandidate {
  action: 'add_waypoint' | 'update_waypoint';
  name?: string;
  place_name?: string;
  address?: string;
  google_place_id?: string;
  type?: string;
  dwell_minutes?: number;
  is_route_anchor?: boolean;
  lat?: number;
  lng?: number;
}

export type FetchJsonWithTimeoutFn = <T>(
  url: string,
  init: RequestInit,
  upstreamLabel: string,
  abortSignal?: AbortSignal,
  customTimeoutMs?: number
) => Promise<T>;

export const SCOUT_TOOL_DECLARATIONS: ScoutToolDeclaration[] = [
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
