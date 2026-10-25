import { describe, expect, it } from 'vitest';
import type {
  PlaceMatchCandidate,
  ResolvedPlaceRecord,
} from '../../server/services/scoutTools.js';
import {
  hydrateSuggestionFromResolvedPlaces,
  matchResolvedPlaceForSuggestion,
  parseScoutResponse,
} from '../../server/services/scoutService.js';

const SEDONA_MAVERIK_ID = 'ChIJCR3fWhuQO4cRxCLXXbAfCxQ';
const FLAGSTAFF_MAVERIK_ID = 'ChIJU-n6g1cMK4cRy5T6Z8-Jq9Q';
const EAST_FLAGSTAFF_MAVERIK_ID = 'ChIJ2wW_a80KK4cR24D7xO_z5Y4';

const sedonaMaverik: ResolvedPlaceRecord = {
  query: 'Maverik Sedona',
  place_name: 'Maverik',
  display_name: 'Maverik',
  address: '200 W State Route 89A Sedona',
  lat: 34.865,
  lng: -111.763,
  google_place_id: SEDONA_MAVERIK_ID,
};

const flagstaffMaverik: ResolvedPlaceRecord = {
  query: 'Maverik Flagstaff',
  place_name: 'Maverik',
  display_name: 'Maverik',
  address: '1000 W Route 66, Flagstaff, AZ 86001',
  lat: 35.1983,
  lng: -111.6513,
  google_place_id: FLAGSTAFF_MAVERIK_ID,
};

const eastFlagstaffMaverik: ResolvedPlaceRecord = {
  query: 'Maverik East Flagstaff',
  place_name: 'Maverik',
  display_name: 'Maverik',
  address: '2500 E Lucky Ln, Flagstaff, AZ 86004',
  lat: 35.205,
  lng: -111.615,
  google_place_id: EAST_FLAGSTAFF_MAVERIK_ID,
};

function maverikCandidate(overrides: Partial<PlaceMatchCandidate> = {}): PlaceMatchCandidate {
  return {
    action: 'add_waypoint',
    name: 'Maverik Fuel Stop',
    place_name: 'Maverik',
    type: 'fuel',
    dwell_minutes: 15,
    ...overrides,
  };
}

describe('Route Scout duplicate place evidence', () => {
  it('matches repeated identical resolution evidence when the suggestion omits coordinates', () => {
    const matched = matchResolvedPlaceForSuggestion(maverikCandidate(), [
      sedonaMaverik,
      { ...sedonaMaverik },
    ]);

    expect(matched).toEqual(sedonaMaverik);
  });

  it('matches repeated identical resolution evidence when the suggestion includes coordinates', () => {
    const matched = matchResolvedPlaceForSuggestion(
      maverikCandidate({ lat: 34.8697, lng: -111.761 }),
      [sedonaMaverik, { ...sedonaMaverik }]
    );

    expect(matched).toEqual(sedonaMaverik);
  });

  it('is order invariant for repeated identical records', () => {
    const orders = [
      [sedonaMaverik, { ...sedonaMaverik }],
      [{ ...sedonaMaverik }, sedonaMaverik],
    ];

    for (const resolvedPlaces of orders) {
      const matched = matchResolvedPlaceForSuggestion(maverikCandidate(), resolvedPlaces);
      expect(matched).toBeDefined();
      expect(matched?.google_place_id).toBe(SEDONA_MAVERIK_ID);
      expect(matched?.address).toBe(sedonaMaverik.address);
      expect(matched?.lat).toBe(sedonaMaverik.lat);
      expect(matched?.lng).toBe(sedonaMaverik.lng);
    }
  });

  it('parseScoutResponse survives omitted coordinates when resolution evidence is duplicated', () => {
    const rawOutput = `Adding a fuel stop in Sedona:
\`\`\`json:suggestions
[
  {
    "action": "add_waypoint",
    "name": "Maverik",
    "place_name": "Maverik",
    "type": "fuel",
    "dwell_minutes": 15,
    "reason": "Refuel in Sedona."
  }
]
\`\`\``;

    const parsed = parseScoutResponse(rawOutput, {
      resolvedPlaces: [sedonaMaverik, { ...sedonaMaverik }],
      knownPlaceIds: new Set([SEDONA_MAVERIK_ID]),
    });

    expect(parsed.suggestions).toHaveLength(1);
    expect(parsed.suggestions[0].google_place_id).toBe(SEDONA_MAVERIK_ID);
    expect(parsed.suggestions[0].address).toBe(sedonaMaverik.address);
    expect(parsed.suggestions[0].lat).toBe(sedonaMaverik.lat);
    expect(parsed.suggestions[0].lng).toBe(sedonaMaverik.lng);
  });

  it('does not merge distinct branches that share the same search query', () => {
    const sameQueryDistinctBranches: ResolvedPlaceRecord[] = [
      { ...sedonaMaverik, query: 'Maverik' },
      { ...eastFlagstaffMaverik, query: 'Maverik' },
    ];

    expect(
      matchResolvedPlaceForSuggestion(maverikCandidate(), sameQueryDistinctBranches)
    ).toBeUndefined();
    expect(
      matchResolvedPlaceForSuggestion(
        maverikCandidate(),
        [...sameQueryDistinctBranches].reverse()
      )
    ).toBeUndefined();

    for (const resolvedPlaces of [
      sameQueryDistinctBranches,
      [...sameQueryDistinctBranches].reverse(),
    ]) {
      const disambiguated = matchResolvedPlaceForSuggestion(
        maverikCandidate({ address: 'Lucky Ln' }),
        resolvedPlaces
      );
      expect(disambiguated?.google_place_id).toBe(EAST_FLAGSTAFF_MAVERIK_ID);
      expect(disambiguated?.address).toBe(eastFlagstaffMaverik.address);
    }
  });

  it('does not treat query echo as qualifier evidence for a returned entity', () => {
    const route66Maverik: ResolvedPlaceRecord = {
      query: 'Maverik Lucky Lane Flagstaff',
      place_name: 'Maverik',
      display_name: 'Maverik',
      address: '1000 W Route 66 Flagstaff AZ',
      lat: 35.1983,
      lng: -111.6513,
      google_place_id: FLAGSTAFF_MAVERIK_ID,
    };
    const candidate: PlaceMatchCandidate = {
      action: 'update_waypoint',
      name: 'Maverik (Lucky Lane)',
      place_name: 'Maverik',
      address: 'Lucky Lane',
      type: 'fuel',
      lat: 35.2015,
      lng: -111.633,
    };

    expect(matchResolvedPlaceForSuggestion(candidate, [route66Maverik])).toBeUndefined();

    for (const resolvedPlaces of [
      [route66Maverik, { ...route66Maverik }],
      [{ ...route66Maverik }, route66Maverik],
    ]) {
      expect(matchResolvedPlaceForSuggestion(candidate, resolvedPlaces)).toBeUndefined();
    }
  });

  it('preserves returned display/address qualifier evidence across consistent duplicate records', () => {
    const base: ResolvedPlaceRecord = {
      query: 'Maverik East Flagstaff route lookup',
      place_name: 'Maverik',
      display_name: 'Maverik',
      address: '',
      lat: 35.2015,
      lng: -111.633,
      google_place_id: EAST_FLAGSTAFF_MAVERIK_ID,
    };
    const evidenceCases: Array<{
      first: ResolvedPlaceRecord;
      second: ResolvedPlaceRecord;
    }> = [
      {
        first: base,
        second: {
          ...base,
          query: 'Maverik',
          display_name: 'Maverik Lucky Lane',
        },
      },
      {
        first: base,
        second: {
          ...base,
          query: 'Maverik',
          address: 'Lucky Lane Flagstaff AZ',
        },
      },
    ];

    for (const { first, second } of evidenceCases) {
      for (const resolvedPlaces of [
        [first, second],
        [second, first],
      ]) {
        const matched = matchResolvedPlaceForSuggestion(
          maverikCandidate({ address: 'Lucky Lane' }),
          resolvedPlaces
        );
        expect(matched).toBeDefined();
        expect(matched?.google_place_id).toBe(EAST_FLAGSTAFF_MAVERIK_ID);
      }
    }
  });

  it('never silently merges conflicting entity records', () => {
    const conflictingAddress: ResolvedPlaceRecord = {
      ...sedonaMaverik,
      address: '999 Different Rd Sedona',
    };
    const conflictingId: ResolvedPlaceRecord = {
      ...sedonaMaverik,
      google_place_id: EAST_FLAGSTAFF_MAVERIK_ID,
    };
    const conflictingCoordinates: ResolvedPlaceRecord = {
      ...sedonaMaverik,
      lat: 34.9,
      lng: -111.8,
    };

    for (const conflict of [
      conflictingAddress,
      conflictingId,
      conflictingCoordinates,
    ]) {
      expect(
        matchResolvedPlaceForSuggestion(maverikCandidate(), [sedonaMaverik, conflict])
      ).toBeUndefined();
      expect(
        matchResolvedPlaceForSuggestion(maverikCandidate(), [conflict, sedonaMaverik])
      ).toBeUndefined();
    }
  });

  it('keeps duplicate evidence for commercial proximity but not across distinct branches', () => {
    const proximityCandidate: PlaceMatchCandidate = {
      action: 'add_waypoint',
      type: 'fuel',
      dwell_minutes: 15,
      lat: 34.865,
      lng: -111.763,
    };

    expect(
      matchResolvedPlaceForSuggestion(proximityCandidate, [
        sedonaMaverik,
        { ...sedonaMaverik },
      ])
    ).toEqual(sedonaMaverik);

    const nearbyDistinctBranch: ResolvedPlaceRecord = {
      ...eastFlagstaffMaverik,
      lat: 34.8655,
      lng: -111.7635,
    };
    expect(
      matchResolvedPlaceForSuggestion(proximityCandidate, [
        sedonaMaverik,
        nearbyDistinctBranch,
      ])
    ).toBeUndefined();
  });

  it('keeps different-city exclusion for duplicated evidence', () => {
    const matched = matchResolvedPlaceForSuggestion(
      maverikCandidate({ lat: 34.8697, lng: -111.761 }),
      [flagstaffMaverik, { ...flagstaffMaverik }]
    );

    expect(matched).toBeUndefined();
  });

  it('does not merge distinct non-Latin names sharing coordinates without IDs or addresses', () => {
    const namePairs = [
      { first: '東京', second: '大阪' },
      { first: 'Москва', second: 'Казань' },
      { first: 'Αθήνα', second: 'Πάτρα' },
    ];

    for (const { first, second } of namePairs) {
      const firstRecord: ResolvedPlaceRecord = {
        query: first,
        place_name: first,
        display_name: first,
        address: '',
        lat: 35.6,
        lng: 139.7,
      };
      const secondRecord: ResolvedPlaceRecord = {
        ...firstRecord,
        query: second,
        place_name: second,
        display_name: second,
      };
      const candidate: PlaceMatchCandidate = {
        action: 'add_waypoint',
        place_name: first,
        type: 'meal',
      };

      for (const resolvedPlaces of [
        [firstRecord, secondRecord],
        [secondRecord, firstRecord],
      ]) {
        const matched = matchResolvedPlaceForSuggestion(candidate, resolvedPlaces);
        expect(matched).toBeDefined();
        expect(matched?.place_name).toBe(first);
        expect(matched?.query).toBe(first);
      }
    }
  });

  it('keeps repeated Unicode same-entity records idempotent', () => {
    const tokyo: ResolvedPlaceRecord = {
      query: '東京',
      place_name: '東京',
      display_name: '東京',
      address: '',
      lat: 35.6,
      lng: 139.7,
    };
    const tokyoCandidate: PlaceMatchCandidate = {
      action: 'add_waypoint',
      place_name: '東京',
      type: 'meal',
    };

    for (const resolvedPlaces of [
      [tokyo, { ...tokyo }],
      [{ ...tokyo }, tokyo],
    ]) {
      expect(matchResolvedPlaceForSuggestion(tokyoCandidate, resolvedPlaces)).toEqual(tokyo);
    }

    const accentedCafe: ResolvedPlaceRecord = {
      query: 'Café',
      place_name: 'Café',
      display_name: 'Café',
      address: '',
      lat: 48.8566,
      lng: 2.3522,
    };
    expect(
      matchResolvedPlaceForSuggestion(
        { action: 'add_waypoint', place_name: 'Café', type: 'meal' },
        [accentedCafe, { ...accentedCafe }]
      )
    ).toEqual(accentedCafe);
  });

  it('never normalizes accented-only names into blank placeholders', () => {
    const firstRecord: ResolvedPlaceRecord = {
      query: 'Ä',
      place_name: 'Ä',
      display_name: 'Ä',
      address: '',
      lat: 59.9,
      lng: 10.7,
    };
    const secondRecord: ResolvedPlaceRecord = {
      ...firstRecord,
      query: 'Å',
      place_name: 'Å',
      display_name: 'Å',
    };
    const candidate: PlaceMatchCandidate = {
      action: 'add_waypoint',
      place_name: 'Ä',
      type: 'meal',
    };

    for (const resolvedPlaces of [
      [firstRecord, secondRecord],
      [secondRecord, firstRecord],
    ]) {
      const matched = matchResolvedPlaceForSuggestion(candidate, resolvedPlaces);
      expect(matched).toBeDefined();
      expect(matched?.place_name).toBe('Ä');
      expect(matched?.query).toBe('Ä');
    }
  });
});

describe('Route Scout exact ID duplicate resolution', () => {
  const sparseSedonaMaverik: ResolvedPlaceRecord = {
    ...sedonaMaverik,
    address: '',
  };
  const richSedonaMaverik = sedonaMaverik;

  function exactIdCandidate(googlePlaceId: string): PlaceMatchCandidate {
    return {
      action: 'add_waypoint',
      google_place_id: googlePlaceId,
      type: 'fuel',
    };
  }

  it('returns the richer consistent representative for reversed sparse/rich exact-ID records', () => {
    for (const resolvedPlaces of [
      [sparseSedonaMaverik, richSedonaMaverik],
      [richSedonaMaverik, sparseSedonaMaverik],
    ]) {
      const matched = matchResolvedPlaceForSuggestion(
        exactIdCandidate(SEDONA_MAVERIK_ID),
        resolvedPlaces
      );
      expect(matched).toBeDefined();
      expect(matched?.google_place_id).toBe(SEDONA_MAVERIK_ID);
      expect(matched?.address).toBe(richSedonaMaverik.address);
      expect(matched?.lat).toBe(richSedonaMaverik.lat);
      expect(matched?.lng).toBe(richSedonaMaverik.lng);
    }
  });

  it('keeps the available verified address when hydrating an exact-ID suggestion', () => {
    const hydrated = hydrateSuggestionFromResolvedPlaces(
      {
        id: 'sug_exact_id',
        action: 'add_waypoint',
        name: 'Maverik',
        place_name: 'Maverik',
        google_place_id: SEDONA_MAVERIK_ID,
        type: 'fuel',
        lat: 34.8697,
        lng: -111.761,
        dwell_minutes: 15,
        reason: 'Refuel in Sedona.',
      },
      [sparseSedonaMaverik, richSedonaMaverik],
      new Set([SEDONA_MAVERIK_ID])
    );

    expect(hydrated.google_place_id).toBe(SEDONA_MAVERIK_ID);
    expect(hydrated.address).toBe(richSedonaMaverik.address);
    expect(hydrated.lat).toBe(richSedonaMaverik.lat);
    expect(hydrated.lng).toBe(richSedonaMaverik.lng);
  });

  it('parses omitted coordinates and preserves the verified address for an exact-ID suggestion', () => {
    const rawOutput = `Adding a fuel stop in Sedona:
\`\`\`json:suggestions
[
  {
    "action": "add_waypoint",
    "name": "Maverik",
    "place_name": "Maverik",
    "google_place_id": "${SEDONA_MAVERIK_ID}",
    "type": "fuel",
    "dwell_minutes": 15,
    "reason": "Refuel in Sedona."
  }
]
\`\`\``;

    const parsed = parseScoutResponse(rawOutput, {
      resolvedPlaces: [sparseSedonaMaverik, richSedonaMaverik],
      knownPlaceIds: new Set([SEDONA_MAVERIK_ID]),
    });

    expect(parsed.suggestions).toHaveLength(1);
    expect(parsed.suggestions[0].google_place_id).toBe(SEDONA_MAVERIK_ID);
    expect(parsed.suggestions[0].address).toBe(richSedonaMaverik.address);
    expect(parsed.suggestions[0].lat).toBe(richSedonaMaverik.lat);
    expect(parsed.suggestions[0].lng).toBe(richSedonaMaverik.lng);
  });

  it('matches canonical exact IDs when the candidate ID has surrounding whitespace', () => {
    for (const candidateId of [
      `  ${SEDONA_MAVERIK_ID}  `,
      `\t${SEDONA_MAVERIK_ID}\n`,
      SEDONA_MAVERIK_ID,
    ]) {
      const matched = matchResolvedPlaceForSuggestion(
        exactIdCandidate(candidateId),
        [sparseSedonaMaverik, richSedonaMaverik]
      );
      expect(matched).toBeDefined();
      expect(matched?.google_place_id).toBe(SEDONA_MAVERIK_ID);
      expect(matched?.address).toBe(richSedonaMaverik.address);
    }
  });

  it('does not substitute a different Place ID when the exact ID is absent', () => {
    expect(
      matchResolvedPlaceForSuggestion(
        exactIdCandidate(EAST_FLAGSTAFF_MAVERIK_ID),
        [sparseSedonaMaverik, richSedonaMaverik]
      )
    ).toBeUndefined();
  });

  it('returns undefined for conflicting same-ID records instead of mixing evidence', () => {
    const conflictingAddress: ResolvedPlaceRecord = {
      ...richSedonaMaverik,
      address: '999 Different Rd Sedona',
    };
    const conflictingCoordinates: ResolvedPlaceRecord = {
      ...richSedonaMaverik,
      lat: 34.9,
      lng: -111.8,
    };

    for (const conflict of [conflictingAddress, conflictingCoordinates]) {
      for (const resolvedPlaces of [
        [sparseSedonaMaverik, richSedonaMaverik, conflict],
        [conflict, richSedonaMaverik, sparseSedonaMaverik],
      ]) {
        expect(
          matchResolvedPlaceForSuggestion(
            exactIdCandidate(SEDONA_MAVERIK_ID),
            resolvedPlaces
          )
        ).toBeUndefined();
      }
    }
  });
});
