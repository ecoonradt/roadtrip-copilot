import tzlookup from 'tz-lookup';
import { isValidGooglePlaceId } from '../placeId.js';
import type {
  ScoutWaypointSummary,
  TurnGroundingCache,
  ResolvedPlaceRecord,
  HighwayDesignator,
  PlaceMatchCandidate,
} from './types.js';

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

/**
 * Returns true if a suggestion represents an in-transit scenic drive-by or route-forcing anchor
 * rather than a physical stopping destination.
 */
export function isInTransitOrAnchorSuggestion(
  sug: { type?: string; dwell_minutes?: number; is_route_anchor?: boolean }
): boolean {
  if (sug.type === 'scenic_drive_by' || sug.is_route_anchor === true) {
    return true;
  }
  if (
    sug.dwell_minutes === 0 &&
    sug.type !== 'lodging' &&
    sug.type !== 'destination' &&
    sug.type !== 'origin'
  ) {
    return true;
  }
  return false;
}

export const GENERIC_STOP_WORDS = new Set([
  'stop', 'fuel', 'gas', 'station', 'service', 'center', 'travel', 'meal',
  'lunch', 'dinner', 'breakfast', 'cafe', 'restaurant', 'diner', 'hotel',
  'motel', 'inn', 'lodge', 'lodging', 'resort', 'scenic', 'overlook',
  'vista', 'view', 'point', 'pull', 'off', 'byway', 'the', 'and', 'for',
  'at', 'in', 'on', 'of', 'by', 'to', 'near', 'from', 'exit', 'hwy',
  'highway', 'route', 'st', 'street', 'ave', 'avenue', 'rd', 'road',
  'blvd', 'dr', 'drive', 'ln', 'way', 'az', 'ut', 'ca', 'nv', 'nm',
  'co', 'tx', 'us', 'morning', 'afternoon', 'evening', 'night', 'pit',
  'quick', 'break', 'rest', 'snack', 'coffee', 'waypoint', 'stopover',
  'detour', 'option', 'recommended',
]);

const COORDINATE_EPSILON = 1e-6;

function normalizeEntityText(value: string | undefined): string {
  return (value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

function sameCoordinates(a: ResolvedPlaceRecord, b: ResolvedPlaceRecord): boolean {
  return (
    Math.abs(a.lat - b.lat) <= COORDINATE_EPSILON &&
    Math.abs(a.lng - b.lng) <= COORDINATE_EPSILON
  );
}

/**
 * Two resolved records describe the same verified entity only when they agree on every
 * authoritative field. Missing values (omitted ID or address) are allowed, but conflicting
 * IDs, names, addresses, or coordinates are never merged.
 */
function areConsistentDuplicates(a: ResolvedPlaceRecord, b: ResolvedPlaceRecord): boolean {
  const aName = normalizeEntityText(a.place_name);
  const bName = normalizeEntityText(b.place_name);
  if (aName && bName && aName !== bName) {
    return false;
  }

  const aId = a.google_place_id?.trim();
  const bId = b.google_place_id?.trim();
  if (aId && bId && aId !== bId) {
    return false;
  }

  if (!sameCoordinates(a, b)) {
    return false;
  }

  const aAddress = normalizeEntityText(a.address);
  const bAddress = normalizeEntityText(b.address);
  if (aAddress && bAddress && aAddress !== bAddress) {
    return false;
  }

  return true;
}

function compareRecords(a: ResolvedPlaceRecord, b: ResolvedPlaceRecord): number {
  return (
    (a.google_place_id || '').localeCompare(b.google_place_id || '') ||
    normalizeEntityText(a.place_name).localeCompare(normalizeEntityText(b.place_name)) ||
    normalizeEntityText(a.address).localeCompare(normalizeEntityText(b.address)) ||
    a.lat - b.lat ||
    a.lng - b.lng ||
    (a.query || '').localeCompare(b.query || '') ||
    (a.display_name || '').localeCompare(b.display_name || '')
  );
}

function compareRepresentativePriority(a: ResolvedPlaceRecord, b: ResolvedPlaceRecord): number {
  const idDiff =
    Number(Boolean(b.google_place_id?.trim())) - Number(Boolean(a.google_place_id?.trim()));
  if (idDiff !== 0) return idDiff;

  const addressDiff = Number(Boolean(b.address?.trim())) - Number(Boolean(a.address?.trim()));
  if (addressDiff !== 0) return addressDiff;

  const nameDiff =
    Number(Boolean(normalizeEntityText(b.place_name))) -
    Number(Boolean(normalizeEntityText(a.place_name)));
  if (nameDiff !== 0) return nameDiff;

  const queryLengthDiff = (b.query || '').length - (a.query || '').length;
  if (queryLengthDiff !== 0) return queryLengthDiff;

  return (
    (a.query || '').localeCompare(b.query || '') ||
    (a.display_name || '').localeCompare(b.display_name || '') ||
    compareRecords(a, b)
  );
}

interface ResolvedPlaceGroup {
  records: ResolvedPlaceRecord[];
  representative: ResolvedPlaceRecord;
  evidenceText: string;
}

/**
 * Collapses repeated tool-call evidence for the same verified entity into a single group.
 * Distinct Place IDs / branches stay separate, and conflicting records are never merged.
 */
function buildResolvedPlaceGroups(resolvedPlaces: ResolvedPlaceRecord[]): ResolvedPlaceGroup[] {
  const sorted = [...resolvedPlaces].sort(compareRecords);
  const grouped: ResolvedPlaceRecord[][] = [];

  for (const record of sorted) {
    const existing = grouped.find((group) =>
      group.every((member) => areConsistentDuplicates(member, record))
    );
    if (existing) {
      existing.push(record);
    } else {
      grouped.push([record]);
    }
  }

  return grouped.map((records) => {
    const representative = [...records].sort(compareRepresentativePriority)[0];
    return {
      records,
      representative,
      // Qualifier evidence comes only from verified entity fields; `query` is provenance
      // metadata from the model/tool call and must never verify a branch.
      evidenceText: records
        .map((r) => `${r.display_name || ''} ${r.address || ''}`)
        .join(' ')
        .toLowerCase(),
    };
  });
}

/**
 * Matches and disambiguates a candidate waypoint against grounded resolved places.
 */
export function matchResolvedPlaceForSuggestion(
  candidate: PlaceMatchCandidate,
  resolvedPlaces?: ResolvedPlaceRecord[]
): ResolvedPlaceRecord | undefined {
  if (!resolvedPlaces || resolvedPlaces.length === 0) {
    return undefined;
  }

  // 2. Exact google_place_id match routed through consistent duplicate grouping
  const candidatePlaceId = candidate.google_place_id?.trim();
  if (candidatePlaceId) {
    const idMatches = resolvedPlaces.filter(
      (r) => r.google_place_id?.trim() === candidatePlaceId
    );
    if (idMatches.length === 0) {
      return undefined;
    }

    const idGroups = buildResolvedPlaceGroups(idMatches);
    // Conflicting records sharing an ID must not be mixed or arbitrarily guessed between.
    if (idGroups.length !== 1) {
      return undefined;
    }
    return idGroups[0].representative;
  }

  // Collapse repeated evidence for the same verified entity before ambiguity analysis.
  const resolvedGroups = buildResolvedPlaceGroups(resolvedPlaces);

  // 3. Normalized Name Matching & Multi-Branch Disambiguation
  const sugCleanName = cleanPlaceName(candidate.place_name || candidate.name || '').toLowerCase();
  let nameCandidates: ResolvedPlaceGroup[] = [];

  if (sugCleanName.length > 0) {
    const exactMatches = resolvedGroups.filter((group) =>
      group.records.some((r) => {
        const rPlace = r.place_name.toLowerCase();
        const rDisplay = cleanPlaceName(r.display_name).toLowerCase();
        return (
          (rPlace.length > 0 && rPlace === sugCleanName) ||
          (rDisplay.length > 0 && rDisplay === sugCleanName)
        );
      })
    );

    if (exactMatches.length > 0) {
      nameCandidates = exactMatches;
    } else if (sugCleanName.length >= 4) {
      nameCandidates = resolvedGroups.filter((group) =>
        group.records.some((r) => {
          const rPlace = r.place_name.toLowerCase();
          return (
            rPlace.length >= 4 &&
            (rPlace.includes(sugCleanName) || sugCleanName.includes(rPlace))
          );
        })
      );
    }
  }

  // Distinguishing qualifier/address tokens
  const rawQualifierText = `${candidate.name || ''} ${candidate.address || ''}`.toLowerCase();
  const nameTokens = new Set(sugCleanName.split(/[^a-z0-9]+/).filter(Boolean));
  const allTokens = rawQualifierText.split(/[^a-z0-9]+/).filter(Boolean);
  const qualifierTokens = Array.from(
    new Set(
      allTokens.filter((token) => {
        if (nameTokens.has(token)) return false;
        if (GENERIC_STOP_WORDS.has(token)) return false;
        const isNumeric = /^\d+$/.test(token);
        return token.length >= 3 || (isNumeric && token.length >= 2);
      })
    )
  );

  const hasCoords =
    typeof candidate.lat === 'number' &&
    Number.isFinite(candidate.lat) &&
    typeof candidate.lng === 'number' &&
    Number.isFinite(candidate.lng);

  if (nameCandidates.length > 0) {
    let geoCompatible: ResolvedPlaceGroup[] = hasCoords
      ? nameCandidates.filter(
          (group) =>
            haversineMiles(
              candidate.lat!,
              candidate.lng!,
              group.representative.lat,
              group.representative.lng
            ) <= 10
        )
      : [...nameCandidates];

    if (geoCompatible.length === 0) {
      return undefined;
    }

    if (qualifierTokens.length > 0) {
      const scored = geoCompatible.map((group) => {
        const score = qualifierTokens.filter((t) =>
          new RegExp(`\\b${escapeRegExp(t)}\\b`).test(group.evidenceText)
        ).length;
        return { group, score };
      });
      const maxScore = Math.max(0, ...scored.map((s) => s.score));
      if (maxScore === 0) {
        // Explicit qualifier/address/city tokens on the suggestion do not match any candidate record -> do not guess!
        return undefined;
      }
      const bestTokenMatches = scored
        .filter((s) => s.score === maxScore)
        .map((s) => s.group);
      if (bestTokenMatches.length === 1) {
        return bestTokenMatches[0].representative;
      }
      geoCompatible = bestTokenMatches;
    }

    if (geoCompatible.length === 1) {
      return geoCompatible[0].representative;
    }

    if (geoCompatible.length > 1) {
      if (!hasCoords) {
        return undefined;
      }
      const sorted = geoCompatible
        .map((group) => ({
          group,
          dist: haversineMiles(
            candidate.lat!,
            candidate.lng!,
            group.representative.lat,
            group.representative.lng
          ),
        }))
        .sort((a, b) => a.dist - b.dist);

      const best = sorted[0];
      const second = sorted[1];
      if (
        best.dist <= 2.0 &&
        (second.dist > 5.0 || (best.dist <= 0.5 && second.dist >= Math.max(0.5, best.dist * 3)))
      ) {
        return best.group.representative;
      }
      return undefined;
    }
  }

  // 4. Proximity Fallback (<= 0.15 miles)
  if (
    nameCandidates.length === 0 &&
    hasCoords &&
    candidate.action === 'add_waypoint' &&
    (candidate.type === 'meal' || candidate.type === 'fuel' || candidate.type === 'lodging') &&
    !isInTransitOrAnchorSuggestion({
      type: candidate.type || '',
      dwell_minutes: candidate.dwell_minutes,
      is_route_anchor: candidate.is_route_anchor,
    })
  ) {
    if (candidate.place_name && candidate.place_name.trim().length > 0) {
      return undefined;
    }
    const proximityCandidates = resolvedGroups.filter(
      (group) =>
        haversineMiles(
          candidate.lat!,
          candidate.lng!,
          group.representative.lat,
          group.representative.lng
        ) <= 0.15
    );
    if (proximityCandidates.length === 1) {
      return proximityCandidates[0].representative;
    }
  }

  return undefined;
}
