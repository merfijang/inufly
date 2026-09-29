import { describe, expect, it } from 'vitest';
import { BalanceFeeWatcher } from './balanceWatcher';
import type { FeeEvent, RpcClient } from './solanaWatcher';

function chain(balances: number[]) {
  let i = 0;
  const rpc: RpcClient = { async call(method) { if (method !== 'getBalance') throw new Error(method); return { context: { slot: 100 + i }, value: balances[Math.min(i++, balances.length - 1)] } as never; } };
  return rpc;
}

describe('BalanceFeeWatcher', () => {
  it('takes the first balance as the baseline without counting it', async () => {
    const fees: FeeEvent[] = [];
    const w = new BalanceFeeWatcher(chain([500]), 'Vault', null, (e) => fees.push(e));
    await w.poll();
    expect(fees).toEqual([]);
    expect(w.lastBalance).toBe(500);
  });

  it('reports each increase as a fee inflow', async () => {
    const fees: FeeEvent[] = [];
    const w = new BalanceFeeWatcher(chain([100, 160, 160, 400]), 'Vault', null, (e) => fees.push(e));
    for (let k = 0; k < 4; k++) await w.poll();
    expect(fees.map((f) => f.lamports)).toEqual([60, 240]);
  });

  it('treats a drop (the creator claiming fees) as a new baseline', async () => {
    const fees: FeeEvent[] = [];
    const w = new BalanceFeeWatcher(chain([900, 0, 30]), 'Vault', 900, (e) => fees.push(e));
    await w.poll(); await w.poll(); await w.poll();
    expect(fees.map((f) => f.lamports)).toEqual([30]);
  });

  it('resumes from a persisted balance and exposes the new one inside the callback', async () => {
    const seen: (number | null)[] = [];
    const w: BalanceFeeWatcher = new BalanceFeeWatcher(chain([250]), 'Vault', 200, () => seen.push(w.lastBalance));
    await w.poll();
    expect(seen).toEqual([250]);
  });
});
