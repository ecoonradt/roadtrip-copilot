/**
 * Structurally verifies a Google Place ID against Google's binary protobuf specification:
 * - Starts with "ChIJ"
 * - Base64url encoded
 * - Decodes to exactly 20 bytes with tags: byte[0]=0x0a, byte[1]=0x12, byte[2]=0x09, byte[11]=0x11
 */
export function isValidGooglePlaceId(placeId: string): boolean {
  if (typeof placeId !== 'string') return false;
  const trimmed = placeId.trim();
  if (!/^ChIJ[A-Za-z0-9_-]{20,45}$/.test(trimmed)) {
    return false;
  }
  try {
    let b64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const buf = Buffer.from(b64, 'base64');
    if (buf.length !== 20) return false;
    return buf[0] === 0x0a && buf[1] === 0x12 && buf[2] === 0x09 && buf[11] === 0x11;
  } catch {
    return false;
  }
}

/**
 * Deterministically validates a Google Place ID returned by Route Scout or external AI.
 * Strips invalid or unverified place IDs.
 * Rules:
 * 1. If knownPlaceIds is provided and contains the ID, it is trusted immediately.
 * 2. Otherwise, newly returned Place IDs must pass the binary protobuf structural validation.
 * "No Place ID is always better than a wrong Place ID."
 */
export function validateScoutPlaceId(
  placeId: unknown,
  knownPlaceIds?: Set<string>
): string | undefined {
  if (typeof placeId !== 'string') return undefined;
  const trimmed = placeId.trim();
  if (!trimmed) return undefined;

  // 1. If in known verified IDs, accept directly
  if (knownPlaceIds && knownPlaceIds.has(trimmed)) {
    return trimmed;
  }

  // 2. Binary Protobuf structural validation
  if (!isValidGooglePlaceId(trimmed)) {
    return undefined;
  }

  return trimmed;
}
