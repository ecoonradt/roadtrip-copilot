import type { GeocodeResult, NominatimRawResult } from '../types/index.js';

export const NOMINATIM_USER_AGENT = 'RoadtripCoPilotRouteBuilder/1.0 (https://github.com/roadtrip-copilot)';
export const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org/search';

function resolveCategory(osmClass?: string, osmType?: string): GeocodeResult['category'] | undefined {
  if (!osmClass && !osmType) return undefined;
  if (osmClass === 'amenity' && osmType === 'fuel') return 'fuel';
  if (
    osmClass === 'amenity' &&
    ['restaurant', 'fast_food', 'cafe', 'pub', 'bar', 'food_court', 'ice_cream', 'bakery'].includes(osmType || '')
  ) {
    return 'meal';
  }
  if (
    osmClass === 'tourism' &&
    ['hotel', 'motel', 'hostel', 'guest_house', 'camp_site', 'caravan_site', 'chalet'].includes(osmType || '')
  ) {
    return 'lodging';
  }
  if (
    (osmClass === 'tourism' && ['viewpoint', 'attraction', 'theme_park', 'zoo', 'museum'].includes(osmType || '')) ||
    (osmClass === 'leisure' && ['park', 'nature_reserve'].includes(osmType || '')) ||
    osmClass === 'historic' ||
    osmClass === 'natural'
  ) {
    return 'scenic_pull_off';
  }
  return 'scenic_pull_off';
}

function formatAddress(item: NominatimRawResult): string | undefined {
  const addr = item.address;
  if (!addr) return undefined;

  const houseNumber = addr.house_number?.trim();
  const road = (addr.road || addr.pedestrian || addr.street || addr.residential || addr.footway || addr.path)?.trim();
  let streetPart = '';
  if (houseNumber && road) {
    streetPart = `${houseNumber} ${road}`;
  } else if (road) {
    streetPart = road;
  }

  const city = (addr.city || addr.town || addr.village || addr.hamlet || addr.municipality || addr.suburb)?.trim();

  let state = addr.state?.trim();
  if (addr['ISO3166-2-lvl4']) {
    const parts = addr['ISO3166-2-lvl4'].split('-');
    if (parts.length === 2 && parts[1].length === 2) {
      state = parts[1];
    }
  }

  const postcode = addr.postcode?.trim();
  const countryCode = addr.country_code?.toLowerCase();

  const parts: string[] = [];
  if (streetPart) parts.push(streetPart);
  if (city) parts.push(city);

  let stateZip = '';
  if (state && postcode) {
    stateZip = `${state} ${postcode}`;
  } else if (state) {
    stateZip = state;
  } else if (postcode) {
    stateZip = postcode;
  }
  if (stateZip) parts.push(stateZip);

  if (countryCode && countryCode !== 'us' && addr.country) {
    parts.push(addr.country.trim());
  }

  return parts.length > 0 ? parts.join(', ') : item.display_name || undefined;
}

function resolvePlaceAndStopName(item: NominatimRawResult): { name?: string; placeName?: string } {
  const addr = item.address;
  const houseNumber = addr?.house_number?.trim();
  const road = (addr?.road || addr?.pedestrian || addr?.street || addr?.residential || addr?.footway || addr?.path)?.trim();
  const streetPart = houseNumber && road ? `${houseNumber} ${road}` : (road || '');

  const rawName = item.name?.trim();
  const isDigitOnly = rawName ? /^\d+$/.test(rawName) : false;

  const poiName =
    rawName && !isDigitOnly
      ? rawName
      : addr?.shop?.trim() ||
        addr?.amenity?.trim() ||
        addr?.tourism?.trim() ||
        addr?.leisure?.trim() ||
        addr?.historic?.trim() ||
        addr?.building?.trim();

  if (poiName && !/^\d+$/.test(poiName)) {
    return {
      name: poiName,
      placeName: poiName,
    };
  }

  if (streetPart) {
    return {
      name: streetPart,
      placeName: streetPart,
    };
  }

  if (rawName && !isDigitOnly) {
    return {
      name: rawName,
      placeName: rawName,
    };
  }

  return {};
}

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

      const { name, placeName } = resolvePlaceAndStopName(item);
      const address = formatAddress(item);
      const category = resolveCategory(item.class, item.type);

      return {
        lat: parseFloat(item.lat),
        lng: parseFloat(item.lon),
        displayName: item.display_name,
        ...(name ? { name } : {}),
        ...(placeName ? { placeName } : {}),
        ...(address ? { address } : {}),
        ...(category ? { category } : {}),
        ...(boundingBox ? { boundingBox } : {}),
      };
    });
  }
}

export const defaultGeocodeService = new GeocodeService();
