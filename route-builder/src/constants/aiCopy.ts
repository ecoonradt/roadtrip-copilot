/**
 * Provider-neutral copy for AI-disabled UI states.
 *
 * The studio must never name a specific AI vendor in the interface: the active
 * backend is an implementation detail behind the provider adapter seam.
 */
export const AI_UNAVAILABLE_LABEL = 'AI unavailable';

export const AI_UNAVAILABLE_SHORT = 'AI features unavailable';

export const AI_UNAVAILABLE_TOOLTIP = 'AI features are unavailable.';

export const AI_UNAVAILABLE_SCOUT_MESSAGE =
  'AI features are unavailable, so Route Scout cannot run. Timeline cascading, manual waypoint editing, and device sync remain fully functional.';

export const AI_UNAVAILABLE_ALERT_MESSAGE =
  'AI features are unavailable, so alerts cannot be generated automatically. You can manually author or edit the card title, message, and spoken audio script below.';
