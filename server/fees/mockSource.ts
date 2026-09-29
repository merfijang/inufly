import type { FeeEvent } from './solanaWatcher';

/**
 * Fake fee inflows (0.005–0.03 SOL) for development, demos and dry runs.
 * With `totalLamports` it stops once exactly that much has been emitted. Returns a stop function.
 */
export function mockFees(everyMs: number, onFee: (e: FeeEvent) => void, rand = Math.random, totalLamports = Infinity) {
  let n = 0, sent = 0;
  const timer = setInterval(() => {
    const lamports = Math.min(Math.round((0.005 + rand() * 0.025) * 1e9), totalLamports - sent);
    if (lamports <= 0) { clearInterval(timer); return; }
    n++; sent += lamports;
    onFee({ signature: `mock-${Date.now()}-${n}`, lamports, slot: 0, blockTime: Math.floor(Date.now() / 1000) });
    if (sent >= totalLamports) clearInterval(timer);
  }, everyMs);
  return () => clearInterval(timer);
}
