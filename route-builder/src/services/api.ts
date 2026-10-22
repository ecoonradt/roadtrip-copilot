import type { GeocodeResult, RouteResponse } from '../types/routing';
import type {
  WaypointContext,
  GenerateAlertResult,
  BatchAlertResult,
  AiEngineType,
} from '../types/ai';
import type {
  ScoutChatRequest,
  ScoutChatResponse,
  ScoutScope,
  ScoutStreamEvent,
} from '../types/scout';
import type { AuthStatusResponse } from '../types/auth';

export interface GenerateAlertRequestOptions {
  apiKey?: string;
  preferredEngine?: AiEngineType | 'auto';
}

export interface AiStatusResult {
  available: boolean;
  message?: string;
}

export async function fetchAiStatus(apiKey?: string): Promise<AiStatusResult> {
  const url = apiKey ? `/api/ai/status?apiKey=${encodeURIComponent(apiKey)}` : '/api/ai/status';
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return {
        available: false,
        message: 'AI features are currently unavailable.',
      };
    }
    return (await res.json()) as AiStatusResult;
  } catch {
    return {
      available: false,
      message: 'AI features are currently unavailable.',
    };
  }
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
  isProtected?: boolean;
  etag?: string;
}

export async function fetchItineraryList(): Promise<{ itineraries: ItineraryMetadataSummary[] }> {
  const res = await fetch('/api/itineraries');
  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({ error: 'Failed to list itineraries' }))) as {
      error?: string;
    };
    throw new ApiError(
      errorData.error || `Failed to list itineraries with HTTP ${res.status}`,
      res.status
    );
  }
  return (await res.json()) as { itineraries: ItineraryMetadataSummary[] };
}

export async function fetchItinerary(fileName: string): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/itineraries/${encodeURIComponent(fileName)}`);
  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({ error: 'Failed to load itinerary' }))) as {
      error?: string;
    };
    throw new ApiError(
      errorData.error || `Failed to load itinerary with HTTP ${res.status}`,
      res.status
    );
  }
  const data = (await res.json()) as Record<string, unknown>;
  const etag = res.headers.get('ETag');
  if (etag && !data._etag) {
    data._etag = etag;
  }
  return data;
}

export interface SaveItineraryApiOptions {
  ifMatch?: string;
  ifNoneMatch?: string;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function saveItinerary(
  fileName: string,
  content: unknown,
  options?: SaveItineraryApiOptions
): Promise<{ success: boolean; fileName: string; filePath: string; etag?: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options?.ifMatch) {
    headers['If-Match'] = options.ifMatch;
  }
  if (options?.ifNoneMatch) {
    headers['If-None-Match'] = options.ifNoneMatch;
  }

  const res = await fetch(`/api/itineraries/${encodeURIComponent(fileName)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content }),
  });

  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({ error: 'Failed to save itinerary' }))) as {
      error?: string;
    };
    throw new ApiError(
      errorData.error || `Failed to save itinerary with HTTP ${res.status}`,
      res.status
    );
  }

  const data = (await res.json()) as { success: boolean; fileName: string; filePath: string; etag?: string };
  const etag = res.headers.get('ETag');
  if (etag && !data.etag) {
    data.etag = etag;
  }
  return data;
}

export async function deleteItinerary(
  fileName: string,
  options?: { ifMatch?: string }
): Promise<{ success: boolean; fileName: string }> {
  const headers: Record<string, string> = {};
  if (options?.ifMatch) {
    headers['If-Match'] = options.ifMatch;
  }

  const res = await fetch(`/api/itineraries/${encodeURIComponent(fileName)}`, {
    method: 'DELETE',
    headers,
  });

  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({ error: 'Failed to delete itinerary' }))) as {
      error?: string;
    };
    throw new ApiError(
      errorData.error || `Failed to delete itinerary with HTTP ${res.status}`,
      res.status
    );
  }

  return (await res.json()) as { success: boolean; fileName: string };
}

export async function chatWithScout(request: ScoutChatRequest): Promise<ScoutChatResponse> {
  const res = await fetch('/api/ai/scout/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({ error: 'Route Scout request failed' }))) as {
      error?: string;
    };
    throw new Error(errorData.error || `Route Scout request failed with HTTP ${res.status}`);
  }

  return (await res.json()) as ScoutChatResponse;
}

export async function chatWithScoutStream(
  request: ScoutChatRequest,
  onEvent: (event: ScoutStreamEvent) => void
): Promise<ScoutChatResponse> {
  const res = await fetch('/api/ai/scout/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({ error: 'Route Scout stream request failed' }))) as {
      error?: string;
    };
    throw new Error(errorData.error || `Route Scout stream failed with HTTP ${res.status}`);
  }

  if (!res.body) {
    throw new Error('Response body is null');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finalResponse: ScoutChatResponse | null = null;

  const processFrame = (frame: string) => {
    let eventType = 'message';
    let dataStr = '';

    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) {
        eventType = line.replace(/^event:\s*/, '').trim();
      } else if (line.startsWith('data:')) {
        dataStr = line.replace(/^data:\s*/, '').trim();
      }
    }

    if (!dataStr) return;

    const parsedData = JSON.parse(dataStr);
    if (eventType === 'error') {
      const errEvt: ScoutStreamEvent = { event: 'error', data: parsedData };
      onEvent(errEvt);
      throw new Error(parsedData.error || 'Streaming error');
    } else if (eventType === 'thought') {
      onEvent({ event: 'thought', data: parsedData });
    } else if (eventType === 'activity') {
      onEvent({ event: 'activity', data: parsedData });
    } else if (eventType === 'delta') {
      onEvent({ event: 'delta', data: parsedData });
    } else if (eventType === 'suggestions') {
      onEvent({ event: 'suggestions', data: parsedData });
    } else if (eventType === 'done') {
      finalResponse = parsedData as ScoutChatResponse;
      onEvent({ event: 'done', data: finalResponse });
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundaryIndex: number;
      while ((boundaryIndex = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundaryIndex).trim();
        buffer = buffer.slice(boundaryIndex + 2);
        if (frame) {
          processFrame(frame);
        }
      }
    }

    if (buffer.trim()) {
      processFrame(buffer.trim());
    }
  } catch (err: unknown) {
    await reader.cancel().catch(() => {});
    throw err;
  } finally {
    reader.releaseLock();
  }

  if (!finalResponse) {
    throw new Error('Stream completed without receiving final response');
  }

  return finalResponse;
}

export async function fetchScoutQuickPrompts(scope: ScoutScope): Promise<string[]> {
  const query = new URLSearchParams({
    type: scope.type,
    ...(scope.dayNumber !== undefined ? { dayNumber: String(scope.dayNumber) } : {}),
    ...(scope.waypointId ? { waypointId: scope.waypointId } : {}),
    ...(scope.waypointName ? { waypointName: scope.waypointName } : {}),
  });

  const res = await fetch(`/api/ai/scout/quick-prompts?${query.toString()}`);
  if (!res.ok) {
    return [];
  }
  const data = (await res.json()) as { prompts?: string[] };
  return data.prompts || [];
}

export async function generateDayTitle(
  dayNumber: number,
  stops: Array<{ name: string; type?: string }>,
  options: GenerateAlertRequestOptions = {}
): Promise<{ title: string; engine: AiEngineType }> {
  const res = await fetch('/api/copilot/day-title', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dayNumber, stops, ...options }),
  });
  if (!res.ok) {
    const errorData = (await res.json().catch(() => ({ error: 'Day title generation failed' }))) as { error?: string };
    throw new Error(errorData.error || `Day title generation failed with HTTP ${res.status}`);
  }
  return (await res.json()) as { title: string; engine: AiEngineType };
}

export async function fetchAuthStatus(signal?: AbortSignal): Promise<AuthStatusResponse> {
  try {
    const res = await fetch('/api/auth/status', {
      credentials: 'same-origin',
      signal,
    });
    if (res.status === 401) {
      return {
        authEnabled: true,
        authenticated: false,
        authorized: false,
        user: null,
      };
    }
    if (!res.ok) {
      try {
        const errorData = (await res.json()) as AuthStatusResponse;
        if (typeof errorData?.authEnabled === 'boolean') {
          return errorData;
        }
      } catch {
        // Fallback below
      }
      return {
        authEnabled: true,
        authenticated: false,
        authorized: false,
        user: null,
        message: `Unable to connect to the authentication service (HTTP ${res.status}). Please check your connection and retry.`,
      };
    }
    return (await res.json()) as AuthStatusResponse;
  } catch {
    return {
      authEnabled: true,
      authenticated: false,
      authorized: false,
      user: null,
      message: 'Unable to connect to Roadtrip Co-Pilot server. Please check your connection and retry.',
    };
  }
}

export async function logoutAuth(): Promise<void> {
  const res = await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!res.ok) {
    throw new Error(`Logout failed with status ${res.status}`);
  }
}
