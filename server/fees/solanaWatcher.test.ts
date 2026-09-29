import { describe, expect, it } from 'vitest';
import { inflowFromTx, SolanaFeeWatcher, touchesMint, type FeeEvent, type RpcClient, type WatcherCursor } from './solanaWatcher';

const WALLET = 'Vault111';

const tx = (pre: number, post: number, opts: { err?: unknown; lookup?: boolean } = {}) => ({
  slot: 1, blockTime: 1_700_000_000,
  meta: {
    err: opts.err ?? null, preBalances: opts.lookup ? [5, pre] : [5, pre], postBalances: opts.lookup ? [4, post] : [4, post],
    loadedAddresses: opts.lookup ? { writable: [WALLET], readonly: [] } : { writable: [], readonly: [] }
  },
  transaction: { message: { accountKeys: opts.lookup ? ['Payer'] : ['Payer', WALLET] } }
});

/** Chain with signatures newest-first, like the real RPC. */
function fakeChain(entries: { sig: string; tx: ReturnType<typeof tx> | null; err?: unknown }[]) {
  const calls: string[] = [];
  const rpc: RpcClient = {
    async call(method, params) {
      calls.push(method);
      const list = [...entries].reverse();
      if (method === 'getSignaturesForAddress') {
        const [, o] = params as [string, { limit: number; until?: string; before?: string }];
        let start = 0;
        if (o.before) start = list.findIndex((e) => e.sig === o.before) + 1;
        const out = [];
        for (let i = start; i < list.length && out.length < o.limit; i++) { if (list[i].sig === o.until) break; out.push({ signature: list[i].sig, slot: 1, err: list[i].err ?? null, blockTime: 1 }); }
        return out as never;
      }
      if (method === 'getTransaction') return (entries.find((e) => e.sig === params[0])?.tx ?? null) as never;
      throw new Error(method);
    }
  };
  return { rpc, calls, entries };
}

describe('inflowFromTx', () => {
  it('counts a positive balance change of the wallet', () => expect(inflowFromTx(tx(100, 350), WALLET)).toBe(250));
  it('ignores outflows such as fee claims', () => expect(inflowFromTx(tx(500, 0), WALLET)).toBe(0));
  it('ignores failed transactions', () => expect(inflowFromTx(tx(100, 350, { err: { InstructionError: [0, 'x'] } }), WALLET)).toBe(0));
  it('finds the wallet among address-lookup-table accounts', () => expect(inflowFromTx(tx(0, 70, { lookup: true }), WALLET)).toBe(70));
  it('returns 0 when the wallet is not in the transaction', () => expect(inflowFromTx(tx(0, 70), 'Other')).toBe(0));
});

describe('SolanaFeeWatcher', () => {
  it('first start only records the newest signature, counting no history', async () => {
    const chain = fakeChain([{ sig: 'a', tx: tx(0, 100) }]);
    const fees: FeeEvent[] = [];
    const w = new SolanaFeeWatcher(chain.rpc, WALLET, null, (e) => fees.push(e));
    await w.poll();
    expect(fees).toEqual([]);
    expect(w.cursor).toEqual<WatcherCursor>({ initialized: true, lastSignature: 'a' });
  });

  it('reports new inflows oldest first, skips claims and failures, then advances the cursor', async () => {
    const chain = fakeChain([{ sig: 'a', tx: tx(0, 100) }]);
    const fees: FeeEvent[] = [];
    const w = new SolanaFeeWatcher(chain.rpc, WALLET, { initialized: true, lastSignature: 'a' }, (e) => fees.push(e));
    chain.entries.push({ sig: 'b', tx: tx(100, 160) }, { sig: 'c', tx: tx(160, 0) }, { sig: 'd', tx: null, err: { x: 1 } }, { sig: 'e', tx: tx(0, 40) });
    await w.poll();
    expect(fees.map((f) => [f.signature, f.lamports])).toEqual([['b', 60], ['e', 40]]);
    expect(w.cursor.lastSignature).toBe('e');
    await w.poll();
    expect(fees).toHaveLength(2);
  });

  it('counts everything on a wallet that was empty when first seen', async () => {
    const chain = fakeChain([]);
    const fees: FeeEvent[] = [];
    const w = new SolanaFeeWatcher(chain.rpc, WALLET, null, (e) => fees.push(e));
    await w.poll();
    chain.entries.push({ sig: 'first', tx: tx(0, 25) });
    await w.poll();
    expect(fees.map((f) => f.lamports)).toEqual([25]);
  });

  it('pages through more signatures than one request returns', async () => {
    const chain = fakeChain([{ sig: 's0', tx: tx(0, 1) }]);
    const fees: FeeEvent[] = [];
    const w = new SolanaFeeWatcher(chain.rpc, WALLET, { initialized: true, lastSignature: 's0' }, (e) => fees.push(e), { pageSize: 3 });
    for (let i = 1; i <= 7; i++) chain.entries.push({ sig: `s${i}`, tx: tx(0, i) });
    await w.poll();
    expect(fees.map((f) => f.lamports)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('stops at a transaction the node cannot return yet and retries it next poll', async () => {
    const chain = fakeChain([{ sig: 'a', tx: tx(0, 1) }]);
    const fees: FeeEvent[] = [];
    const w = new SolanaFeeWatcher(chain.rpc, WALLET, { initialized: true, lastSignature: 'a' }, (e) => fees.push(e));
    chain.entries.push({ sig: 'b', tx: null }, { sig: 'c', tx: tx(0, 9) });
    await w.poll();
    expect(fees).toEqual([]);
    expect(w.cursor.lastSignature).toBe('a');
    chain.entries[1].tx = tx(0, 3);
    await w.poll();
    expect(fees.map((f) => f.lamports)).toEqual([3, 9]);
  });

  it('asks for the newer transaction version the node reports instead of getting stuck', async () => {
    const versions: number[] = [];
    const rpc: RpcClient = {
      async call(method, params) {
        if (method === 'getSignaturesForAddress') return [{ signature: 'b', slot: 1, err: null, blockTime: 1 }] as never;
        const v = (params[1] as { maxSupportedTransactionVersion: number }).maxSupportedTransactionVersion;
        versions.push(v);
        if (v < 2) throw new Error('getTransaction: Transaction version (2) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 2');
        return tx(0, 42) as never;
      }
    };
    const fees: FeeEvent[] = [];
    const w = new SolanaFeeWatcher(rpc, WALLET, { initialized: true, lastSignature: 'a' }, (e) => fees.push(e));
    await w.poll();
    expect(versions).toEqual([1, 2]);
    expect(fees.map((f) => f.lamports)).toEqual([42]);
  });

  it('exposes the updated cursor inside the fee callback so it can be persisted atomically', async () => {
    const chain = fakeChain([{ sig: 'a', tx: tx(0, 1) }]);
    const seen: (string | null)[] = [];
    const w: SolanaFeeWatcher = new SolanaFeeWatcher(chain.rpc, WALLET, { initialized: true, lastSignature: 'a' }, () => seen.push(w.cursor.lastSignature));
    chain.entries.push({ sig: 'b', tx: tx(0, 5) });
    await w.poll();
    expect(seen).toEqual(['b']);
  });
});

describe('unknown cursor', () => {
  it('re-anchors when the node does not know the signature we count from', async () => {
    let calls = 0;
    const rpc: RpcClient = {
      async call(method, params) {
        if (method !== 'getSignaturesForAddress') throw new Error(method);
        const o = (params as [string, { until?: string }])[1];
        calls++;
        if (o.until) throw new Error('getSignaturesForAddress: Transaction 4GY2 not found');
        return [{ signature: 'fresh', slot: 1, err: null, blockTime: 1 }] as never;
      }
    };
    const w = new SolanaFeeWatcher(rpc, WALLET, { initialized: true, lastSignature: 'gone' }, () => undefined);
    await w.poll();
    expect(w.cursor).toEqual({ initialized: false, lastSignature: null });
    await w.poll();
    expect(w.cursor).toEqual({ initialized: true, lastSignature: 'fresh' });
    expect(calls).toBe(2);
  });
});

describe('counting one coin', () => {
  const withMint = (mint: string | null) => ({
    slot: 1, blockTime: 1,
    meta: { err: null, preBalances: [5, 100], postBalances: [4, 160], loadedAddresses: { writable: [], readonly: [] },
      postTokenBalances: mint ? [{ accountIndex: 3, mint }] : [] },
    transaction: { message: { accountKeys: ['Payer', WALLET] } }
  });

  it('knows whether a transaction traded the mint', () => {
    expect(touchesMint(withMint('Coin111') as never, 'Coin111')).toBe(true);
    expect(touchesMint(withMint('Other22') as never, 'Coin111')).toBe(false);
    expect(touchesMint(withMint(null) as never, 'Coin111')).toBe(false);
  });

  it('skips fees that came from the creator other coins', async () => {
    const entries = [{ sig: 'a', tx: tx(0, 1) }, { sig: 'mine', tx: withMint('Coin111') as never }, { sig: 'theirs', tx: withMint('Other22') as never }];
    const chain = fakeChain([entries[0]]);
    const fees: FeeEvent[] = [];
    const w = new SolanaFeeWatcher(chain.rpc, WALLET, { initialized: true, lastSignature: 'a' }, (e) => fees.push(e), { mint: 'Coin111' });
    chain.entries.push(entries[1], entries[2]);
    await w.poll();
    expect(fees.map((f) => f.signature)).toEqual(['mine']);
  });
});
