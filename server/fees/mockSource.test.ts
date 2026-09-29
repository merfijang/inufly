import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockFees } from './mockSource';
import type { FeeEvent } from './solanaWatcher';

afterEach(() => { vi.useRealTimers(); });

describe('mockFees', () => {
  it('emits fees on an interval until stopped', () => {
    vi.useFakeTimers();
    const fees: FeeEvent[] = [];
    const stop = mockFees(100, (e) => fees.push(e), () => 0.5);
    vi.advanceTimersByTime(350);
    stop();
    vi.advanceTimersByTime(1000);
    expect(fees.map((f) => f.lamports)).toEqual([17_500_000, 17_500_000, 17_500_000]);
  });

  it('stops after exactly the requested total', () => {
    vi.useFakeTimers();
    const fees: FeeEvent[] = [];
    mockFees(100, (e) => fees.push(e), () => 0.5, 50_000_000);
    vi.advanceTimersByTime(10_000);
    expect(fees.map((f) => f.lamports)).toEqual([17_500_000, 17_500_000, 15_000_000]);
  });
});
