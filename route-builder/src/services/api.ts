import type { GeocodeResult, RouteResponse } from '../types/routing';
import type {
  WaypointContext,
  GenerateAlertResult,
  BatchAlertResult,
  AiEngineType,
} from '../types/ai';

export interface GenerateAlertRequestOptions {
  apiKey?: string;
  preferredEngine?: AiEngineType | 'auto';
}

export async function searchLocation(query: string): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const res = await fetch(`/api/routing/geocode?q=${encodeURIComponent(trimmed)}`);
  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({ error: 'Geocoding failed' }))) as { error?: string };
    throw new Error(errorData.error || `Geocoding failed with HTTP ${res.status}`);
  }

  return (await res.json()) as GeocodeResult[];
}

export async function fetchRoute(
  coordsList: Array<{ lat: number; lng: number }>
): Promise<RouteResponse> {
  if (coordsList.length < 2) {
    throw new Error('Routing requires at least two points');
  }

  // OSRM format: lon1,lat1;lon2,lat2
  const coordsParam = coordsList.map((p) => `${p.lng},${p.lat}`).join(';');
  const res = await fetch(`/api/routing/route?coords=${encodeURIComponent(coordsParam)}`);

  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({ error: 'Routing failed' }))) as { error?: string };
    throw new Error(errorData.error || `Routing failed with HTTP ${res.status}`);
  }

  return (await res.json()) as RouteResponse;
}

export async function generateCopilotAlert(
  waypoint: WaypointContext,
  options: GenerateAlertRequestOptions = {}
): Promise<GenerateAlertResult> {
  const res = await fetch('/api/copilot/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      waypoint,
      apiKey: options.apiKey,
      preferredEngine: options.preferredEngine,
    }),
  });

  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({ error: 'AI generation failed' }))) as {
      error?: string;
    };
    throw new Error(errorData.error || `AI generation failed with HTTP ${res.status}`);
  }

  return (await res.json()) as GenerateAlertResult;
}

export async function generateBatchCopilotAlerts(
  waypoints: WaypointContext[],
  options: GenerateAlertRequestOptions = {}
): Promise<BatchAlertResult> {
  const res = await fetch('/api/copilot/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      waypoints,
      apiKey: options.apiKey,
      preferredEngine: options.preferredEngine,
    }),
  });

  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({ error: 'Batch AI generation failed' }))) as {
      error?: string;
    };
    throw new Error(errorData.error || `Batch AI generation failed with HTTP ${res.status}`);
  }

  return (await res.json()) as BatchAlertResult;
}

export async function fetchDeviceStatus(): Promise<{ connected: boolean; devices: string[] }> {
  const res = await fetch('/api/device/status');
  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({ error: 'Failed to check device status' }))) as {
      error?: string;
    };
    throw new Error(errorData.error || `Device status check failed with HTTP ${res.status}`);
  }
  return (await res.json()) as { connected: boolean; devices: string[] };
}

export async function pushItineraryToDevice(
  itinerary: unknown,
  fileName?: string
): Promise<{ success: boolean; message?: string; error?: string }> {
  const res = await fetch('/api/device/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itinerary, fileName }),
  });

  const data = (await res.json().catch(() => ({ success: false, error: 'Push request failed' }))) as {
    success: boolean;
    message?: string;
    error?: string;
  };

  return data;
}

export async function stageItinerary(
  itinerary: unknown,
  fileName?: string
): Promise<{ downloadUrl: string; fileName: string }> {
  const res = await fetch('/api/device/stage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itinerary, fileName }),
  });

  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({ error: 'Failed to stage itinerary' }))) as {
      error?: string;
    };
    throw new Error(errorData.error || `Staging failed with HTTP ${res.status}`);
  }

  return (await res.json()) as { downloadUrl: string; fileName: string };
}

export async function fetchNetworkInfo(): Promise<{ ip: string; port: number }> {
  const res = await fetch('/api/device/network-info');
  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({ error: 'Failed to fetch network info' }))) as {
      error?: string;
    };
    throw new Error(errorData.error || `Network info failed with HTTP ${res.status}`);
  }
  return (await res.json()) as { ip: string; port: number };
}

export interface ItineraryDaySummary {
  dayNumber: number;
  date: string;
  title?: string;
  checkpointCount: number;
  origin?: string;
  destination?: string;
}

export interface ItineraryMetadataSummary {
  fileName: string;
  tripName: string;
  isMultiDay: boolean;
  dayCount: number;
  days: ItineraryDaySummary[];
  totalCheckpoints: number;
  dates?: { start: string; end: string };
  lastModified?: string;
}

export async function fetchItineraryList(): Promise<{ itineraries: ItineraryMetadataSummary[] }> {
  const res = await fetch('/api/itineraries');
  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({ error: 'Failed to list itineraries' }))) as {
      error?: string;
    };
    throw new Error(errorData.error || `Failed to list itineraries with HTTP ${res.status}`);
  }
  return (await res.json()) as { itineraries: ItineraryMetadataSummary[] };
}

export async function fetchItinerary(fileName: string): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/itineraries/${encodeURIComponent(fileName)}`);
  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({ error: 'Failed to load itinerary' }))) as {
      error?: string;
    };
    throw new Error(errorData.error || `Failed to load itinerary with HTTP ${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function saveItinerary(
  fileName: string,
  content: unknown
): Promise<{ success: boolean; fileName: string; filePath: string }> {
  const res = await fetch(`/api/itineraries/${encodeURIComponent(fileName)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({ error: 'Failed to save itinerary' }))) as {
      error?: string;
    };
    throw new Error(errorData.error || `Failed to save itinerary with HTTP ${res.status}`);
  }

  return (await res.json()) as { success: boolean; fileName: string; filePath: string };
}
