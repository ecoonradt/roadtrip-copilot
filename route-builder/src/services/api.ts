import type { GeocodeResult, RouteResponse } from '../types/routing';

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
