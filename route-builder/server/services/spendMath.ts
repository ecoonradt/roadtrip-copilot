import { NANOS_PER_USD } from '../types/spend.js';

/**
 * Configuration error: a list rate or environment override is missing or
 * malformed. Raised once at startup so a bad rate never reaches a ledger line.
 */
export class SpendConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpendConfigError';
  }
}

/**
 * Value error: a runtime usage count is not a usable value (negative, fractional,
 * or non-numeric). A computed nanodollar amount that overflows the safe-integer
 * range is raised as a `SpendConfigError` by the conversion guard instead. The
 * split lets ledger and request logs tell a bad runtime value from a bad rate.
 */
export class SpendValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpendValueError';
  }
}

export function roundHalfUpDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new SpendConfigError(`Denominator must be positive: ${denominator}`);
  if (numerator < 0n) throw new SpendConfigError(`Numerator must be non-negative: ${numerator}`);
  return (numerator + denominator / 2n) / denominator;
}

export function parseDecimalUsdStringToNanos(value: string): bigint {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SpendConfigError(`Invalid USD value: ${JSON.stringify(value)}`);
  }
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) throw new SpendConfigError(`Invalid USD value: ${value}`);
  const [whole, fraction = ''] = trimmed.split('.');
  const digits = fraction.slice(0, 9).padEnd(9, '0');
  let result = BigInt(whole) * BigInt(NANOS_PER_USD) + BigInt(digits);
  if (fraction.length > 9 && Number(fraction[9]) >= 5) result += 1n;
  return result;
}

export function toSafeNumberNanos(value: bigint): number {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue)) {
    throw new SpendConfigError(`Nanodollar value is outside safe integer range: ${value}`);
  }
  return numberValue;
}

export function formatUsd(nanos: number): string {
  if (!Number.isInteger(nanos) || nanos < 0) {
    throw new SpendConfigError(`Nanodollars must be a non-negative integer: ${nanos}`);
  }
  if (!Number.isSafeInteger(nanos)) {
    throw new SpendConfigError(`Nanodollars must be a safe integer: ${nanos}`);
  }
  const whole = BigInt(nanos) / BigInt(NANOS_PER_USD);
  const fraction = (BigInt(nanos) % BigInt(NANOS_PER_USD)).toString().padStart(9, '0');
  return `${whole.toString()}.${fraction}`;
}

function countToBigInt(value: number, name: string): bigint {
  if (!Number.isInteger(value) || value < 0) {
    throw new SpendValueError(`${name} must be a non-negative integer: ${value}`);
  }
  return BigInt(value);
}

export function calculatePerUnitCostNanos(count: number, perUnitUsd: string): number {
  return toSafeNumberNanos(countToBigInt(count, 'count') * parseDecimalUsdStringToNanos(perUnitUsd));
}

export function calculatePerMillionRateCostNanos(unitCount: number, perMillionUsd: string): number {
  return toSafeNumberNanos(
    roundHalfUpDivide(
      countToBigInt(unitCount, 'unitCount') * parseDecimalUsdStringToNanos(perMillionUsd),
      1_000_000n,
    ),
  );
}

export function calculateGbSecondCostNanos(
  durationMs: number,
  memoryMb: number,
  perGbSecondUsd: string,
): number {
  // The parsed rate is rounded to nanodollars before the GB-second calculation; cost is then rounded once.
  return toSafeNumberNanos(
    roundHalfUpDivide(
      countToBigInt(durationMs, 'durationMs') *
        countToBigInt(memoryMb, 'memoryMb') *
        parseDecimalUsdStringToNanos(perGbSecondUsd),
      1_024_000n,
    ),
  );
}

export function calculateEgressCostNanos(bytes: number, perGiBUsd: string): number {
  return toSafeNumberNanos(
    roundHalfUpDivide(
      countToBigInt(bytes, 'bytes') * parseDecimalUsdStringToNanos(perGiBUsd),
      1_073_741_824n,
    ),
  );
}

export const LAMBDA_MEMORY_MB = 512;

export interface GlobalServicePricingConfig {
  googlePlacesCostNanos: number;
  braveSearchCostNanos: number;
  lambdaMemoryMb: number;
  lambdaGbSecondCostNanos: number;
  lambdaRequestCostNanos: number;
  s3GetOrHeadCostNanos: number;
  s3PutOrListCostNanos: number;
  s3DeleteCostNanos: number;
  cloudFrontRequestCostNanos: number;
  cloudFrontEgressPerGiBCostNanos: number;
}

function envRate(name: string, fallback: string): number {
  const value = process.env[name] ?? fallback;
  if (value.trim() === '') throw new SpendConfigError(`${name} must not be empty`);
  try {
    return toSafeNumberNanos(parseDecimalUsdStringToNanos(value));
  } catch (err: unknown) {
    throw new SpendConfigError(
      `${name} is invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function loadGlobalServicePricingConfig(): GlobalServicePricingConfig {
  return {
    googlePlacesCostNanos: envRate('GOOGLE_PLACES_COST_USD', '0.035'),
    braveSearchCostNanos: envRate('BRAVE_SEARCH_COST_USD', '0.005'),
    lambdaMemoryMb: LAMBDA_MEMORY_MB,
    lambdaGbSecondCostNanos: envRate('LAMBDA_GB_SECOND_USD', '0.0000166667'),
    lambdaRequestCostNanos: envRate('LAMBDA_REQUEST_USD', '0.0000002'),
    s3GetOrHeadCostNanos: envRate('S3_GET_OR_HEAD_USD', '0.0000004'),
    s3PutOrListCostNanos: envRate('S3_PUT_OR_LIST_USD', '0.000005'),
    s3DeleteCostNanos: 0,
    cloudFrontRequestCostNanos: envRate('CLOUDFRONT_REQUEST_USD', '0.000001'),
    cloudFrontEgressPerGiBCostNanos: envRate('CLOUDFRONT_EGRESS_GIB_USD', '0.085'),
  };
}

/**
 * Resolved once at import time so a malformed override fails fast at startup
 * instead of propagating a bad rate into every ledger line.
 */
export const GLOBAL_SERVICE_PRICING: GlobalServicePricingConfig = loadGlobalServicePricingConfig();
