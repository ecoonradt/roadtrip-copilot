import type { GeocodeResult, NominatimRawResult } from '../types/index.js';

export const NOMINATIM_USER_AGENT = 'RoadtripCoPilotRouteBuilder/1.0 (https://github.com/roadtrip-copilot)';
export const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org/search';

export class GeocodeService {
  private readonly userAgent: string;
  private readonly baseUrl: string;

  constructor(userAgent = NOMINATIM_USER_AGENT, baseUrl = NOMINATIM_BASE_URL) {
    this.userAgent = userAgent;
    this.baseUrl = baseUrl;
  }

  public async geocode(query: string): Promise<GeocodeResult[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      throw new Error('Query parameter "q" cannot be empty');
    }

    const url = new URL(this.baseUrl);
    url.searchParams.set('format', 'json');
    url.searchParams.set('q', trimmed);
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('limit', '10');

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': this.userAgent,
        'Accept': 'application/json',
        'Accept-Language': 'en',
      },
    });

    if (!res.ok) {
      if (res.status === 429) {
        throw new Error('Nominatim geocoding rate limit exceeded. Please wait a moment before searching again.');
      }
      throw new Error(`Nominatim geocoding failed with status: ${res.status} ${res.statusText}`);
    }

    const rawData = (await res.json()) as NominatimRawResult[];

    if (!Array.isArray(rawData)) {
      throw new Error('Invalid response format from Nominatim geocoding service');
    }

    return rawData.map((item): GeocodeResult => {
      let boundingBox: [number, number, number, number] | undefined;
      if (Array.isArray(item.boundingbox) && item.boundingbox.length === 4) {
        const [south, north, west, east] = item.boundingbox.map(Number);
        if (!isNaN(south) && !isNaN(north) && !isNaN(west) && !isNaN(east)) {
          boundingBox = [south, north, west, east];
        }
      }

      return {
        lat: parseFloat(item.lat),
        lng: parseFloat(item.lon),
        displayName: item.display_name,
        ...(boundingBox ? { boundingBox } : {}),
      };
    });
  }
}

export const defaultGeocodeService = new GeocodeService();
