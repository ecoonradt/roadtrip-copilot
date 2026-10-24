let nextSessionSeq = 1;

/**
 * Generates a unique, stable session identifier for an active itinerary.
 * Stays stable across ordinary edits, renames, and saves, but resets on new route creation/import.
 */
export function createItinerarySessionId(): string {
  return `itin_session_${Date.now()}_${nextSessionSeq++}`;
}
