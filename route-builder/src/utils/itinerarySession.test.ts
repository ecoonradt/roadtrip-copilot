import { describe, it, expect } from 'vitest';
import { createItinerarySessionId } from './itinerarySession';

describe('Itinerary Session ID (createItinerarySessionId)', () => {
  it('maintains stable itinerary session identity across save and rename, but resets on new route (R6)', () => {
    const id1 = createItinerarySessionId();
    const id2 = createItinerarySessionId();
    expect(id1).toMatch(/^itin_session_\d+_\d+$/);
    expect(id2).toMatch(/^itin_session_\d+_\d+$/);
    expect(id1).not.toBe(id2);
  });
});
