import { describe, expect, it, vi } from 'vitest';
import {
  calculateEgressCostNanos,
  calculateGbSecondCostNanos,
  calculatePerMillionRateCostNanos,
  calculatePerUnitCostNanos,
  formatUsd,
  parseDecimalUsdStringToNanos,
  roundHalfUpDivide,
  SpendConfigError,
  SpendValueError,
  toSafeNumberNanos,
} from './spendMath.js';

const GLOBAL_RATE_ENV_NAMES = [
  'GOOGLE_PLACES_COST_USD',
  'BRAVE_SEARCH_COST_USD',
  'LAMBDA_GB_SECOND_USD',
  'LAMBDA_REQUEST_USD',
  'S3_GET_OR_HEAD_USD',
  'S3_PUT_OR_LIST_USD',
  'CLOUDFRONT_REQUEST_USD',
  'CLOUDFRONT_EGRESS_GIB_USD',
] as const;

describe('spend math', () => {
  it('formats and parses nanodollars exactly', () => {
    expect(formatUsd(125_000)).toBe('0.000125000');
    expect(formatUsd(0)).toBe('0.000000000');
    expect(formatUsd(1_000_000_000)).toBe('1.000000000');
    expect(formatUsd(407_404_800)).toBe('0.407404800');
    expect(parseDecimalUsdStringToNanos('0.0000166667')).toBe(16_667n);
    expect(() => formatUsd(-1)).toThrow(SpendConfigError);
    expect(() => formatUsd(1.5)).toThrow(SpendConfigError);
    expect(() => formatUsd(2 ** 60)).toThrow(SpendConfigError);
  });

  it('parses decimal USD strings into exact nanodollars', () => {
    expect(parseDecimalUsdStringToNanos('0.0033')).toBe(3_300_000n);
    expect(parseDecimalUsdStringToNanos('0')).toBe(0n);
    expect(parseDecimalUsdStringToNanos('3.0000000000')).toBe(3_000_000_000n);
    expect(parseDecimalUsdStringToNanos('0.5')).toBe(500_000_000n);
    expect(parseDecimalUsdStringToNanos('0.0006200000')).toBe(620_000n);
    for (const invalid of ['', '  ', 'abc', 'NaN', 'Infinity', '-1']) {
      expect(() => parseDecimalUsdStringToNanos(invalid)).toThrow(SpendConfigError);
    }
  });

  it('rounds half-up and rejects invalid division inputs', () => {
    expect(roundHalfUpDivide(1n, 2n)).toBe(1n);
    expect(() => roundHalfUpDivide(-1n, 2n)).toThrow(SpendConfigError);
    expect(() => roundHalfUpDivide(1n, 0n)).toThrow(SpendConfigError);
    expect(() => roundHalfUpDivide(1n, -1n)).toThrow(SpendConfigError);
  });

  it('calculates service costs with integer arithmetic', () => {
    expect(calculatePerUnitCostNanos(1000, '0.0000004')).toBe(400_000);
    expect(calculatePerUnitCostNanos(1000, '0.000005')).toBe(5_000_000);
    expect(calculatePerUnitCostNanos(1, '0.0000002')).toBe(200);
    expect(calculateGbSecondCostNanos(1000, 512, '0.0000166667')).toBe(8334);
    expect(calculateEgressCostNanos(1_073_741_824, '0.085')).toBe(85_000_000);
    expect(calculateEgressCostNanos(100, '0.085')).toBe(8);
    expect(calculatePerMillionRateCostNanos(1_000_000, '3.3')).toBe(3_300_000_000);
    expect(calculatePerMillionRateCostNanos(999, '0.0825')).toBe(82_418);
    expect(() => toSafeNumberNanos(2n ** 63n)).toThrow(SpendConfigError);
  });

  it('rejects invalid counts with a value error, not a configuration error', () => {
    for (const call of [
      () => calculatePerUnitCostNanos(-1, '1'),
      () => calculatePerMillionRateCostNanos(1.5, '1'),
      () => calculateGbSecondCostNanos(1, -1, '1'),
      () => calculateEgressCostNanos(-1, '1'),
    ]) {
      expect(call).toThrow(SpendValueError);
      expect(call).not.toThrow(SpendConfigError);
    }
  });

  it('loads default global service list rates from a clean environment', async () => {
    const saved = { ...process.env };
    try {
      const cleanEnv: NodeJS.ProcessEnv = { ...saved };
      for (const name of GLOBAL_RATE_ENV_NAMES) delete cleanEnv[name];
      process.env = cleanEnv;
      vi.resetModules();
      const configured = await import('./spendMath.js');
      expect(configured.loadGlobalServicePricingConfig()).toEqual({
        googlePlacesCostNanos: 35_000_000,
        braveSearchCostNanos: 5_000_000,
        lambdaMemoryMb: 512,
        lambdaGbSecondCostNanos: 16_667,
        lambdaRequestCostNanos: 200,
        s3GetOrHeadCostNanos: 400,
        s3PutOrListCostNanos: 5_000,
        s3DeleteCostNanos: 0,
        cloudFrontRequestCostNanos: 1_000,
        cloudFrontEgressPerGiBCostNanos: 85_000_000,
      });
    } finally {
      process.env = saved;
      vi.resetModules();
    }
  });

  it('validates every configurable environment rate', async () => {
    const saved = { ...process.env };
    try {
      for (const name of GLOBAL_RATE_ENV_NAMES) for (const invalid of ['abc', '', '-1']) {
        process.env = { ...saved, [name]: invalid };
        vi.resetModules();
        await expect(import('./spendMath.js')).rejects.toThrow(new RegExp(name));
      }
      process.env = { ...saved, GOOGLE_PLACES_COST_USD: '0.05' };
      vi.resetModules();
      const configured = await import('./spendMath.js');
      expect(configured.GLOBAL_SERVICE_PRICING.googlePlacesCostNanos).toBe(50_000_000);
    } finally { process.env = saved; vi.resetModules(); }
  });
});
