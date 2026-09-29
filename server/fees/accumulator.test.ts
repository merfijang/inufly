import { describe, expect, it } from 'vitest';
import { FeeAccumulator } from './accumulator';

const SOL = 1_000_000_000;

describe('FeeAccumulator', () => {
  it('turns whole multiples of the price into attempts and keeps the remainder', () => {
    const acc = new FeeAccumulator(0.05 * SOL);
    expect(acc.add(0.03 * SOL)).toBe(0);
    expect(acc.pending).toBe(0.03 * SOL);
    expect(acc.add(0.08 * SOL)).toBe(2);
    expect(acc.pending).toBe(0.01 * SOL);
  });
  it('resumes from a persisted remainder', () => {
    const acc = new FeeAccumulator(100, 90);
    expect(acc.add(15)).toBe(1);
    expect(acc.pending).toBe(5);
  });
  it('ignores zero, negative and non-finite inflows', () => {
    const acc = new FeeAccumulator(100);
    expect(acc.add(0)).toBe(0);
    expect(acc.add(-50)).toBe(0);
    expect(acc.add(Number.NaN)).toBe(0);
    expect(acc.pending).toBe(0);
  });
  it('rejects a non-positive price', () => {
    expect(() => new FeeAccumulator(0)).toThrow();
  });
});
