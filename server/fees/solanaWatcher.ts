// Watches a Solana wallet (e.g. the pump.fun creator vault) and reports SOL flowing into it.
// Plain JSON-RPC over fetch; no Solana SDK.

export interface RpcClient { call<T>(method: string, params: unknown[]): Promise<T> }

export function httpRpc(url: string): RpcClient {
  let id = 0;
  return {
    async call<T>(method: string, params: unknown[]) {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
      const body = await res.json() as { result?: T; error?: { message?: string } };
      if (body.error) throw new Error(`${method}: ${body.error.message ?? 'rpc error'}`);
      return body.result as T;
    }
  };
}

/** Run `poll` forever; errors back off up to a minute. Returns a stop function. */
export function pollForever(poll: () => Promise<void>, intervalMs: number, log: (msg: string) => void) {
  let stopped = false, delay = intervalMs, timer: ReturnType<typeof setTimeout> | undefined;
  const loop = async () => {
    try { await poll(); delay = intervalMs; } catch (e) { delay = Math.min(60_000, delay * 2); log(`fee watcher: ${e instanceof Error ? e.message : e}`); }
    if (!stopped) timer = setTimeout(loop, delay);
  };
  void loop();
  return () => { stopped = true; clearTimeout(timer); };
}

export interface FeeEvent { signature: string; lamports: number; slot: number; blockTime: number | null }
/** `initialized` distinguishes "never looked" from "looked, wallet had no history". */
export interface WatcherCursor { initialized: boolean; lastSignature: string | null }

interface SignatureInfo { signature: string; slot: number; err: unknown; blockTime: number | null }
interface TokenBalance { accountIndex: number; mint: string }
interface TxJson {
  slot: number; blockTime: number | null;
  meta: {
    err: unknown; preBalances: number[]; postBalances: number[];
    preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
  } | null;
  transaction: { message: { accountKeys: string[] } };
}

/** True if this transaction traded the given mint (used to count one coin, not a creator whole portfolio). */
export function touchesMint(tx: TxJson, mint: string) {
  if ([...tx.transaction.message.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])].includes(mint)) return true;
  return [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])].some((b) => b.mint === mint);
}

/** Lamports the wallet gained in this transaction (0 for outflows, failures, or if absent). */
export function inflowFromTx(tx: TxJson, wallet: string) {
  if (!tx.meta || tx.meta.err) return 0;
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const i = keys.indexOf(wallet);
  if (i < 0) return 0;
  return Math.max(0, tx.meta.postBalances[i] - tx.meta.preBalances[i]);
}

export interface WatchOptions {
  /** Count only fees from trades of this mint, and page its signatures instead of the wallet own. */
  mint?: string | null;
  pageSize?: number;
}

export class SolanaFeeWatcher {
  private state: WatcherCursor;
  private readonly wallets: string[];
  private readonly source: string;
  private readonly mint: string | null;
  private readonly pageSize: number;
  /** Highest transaction version we ask for; raised if the node reports a newer one. */
  private txVersion = 1;

  constructor(private readonly rpc: RpcClient, wallet: string | string[], cursor: WatcherCursor | null,
    private readonly onFee: (e: FeeEvent) => void, opts: WatchOptions = {}) {
    this.wallets = Array.isArray(wallet) ? wallet : [wallet];
    this.mint = opts.mint ?? null;
    this.pageSize = opts.pageSize ?? 100;
    // with a mint, the coin own trades are the short list to walk; the vault list is the creator whole portfolio
    this.source = this.mint ?? this.wallets[0];
    this.state = cursor ?? { initialized: false, lastSignature: null };
  }

  get cursor(): WatcherCursor { return { ...this.state }; }

  private async signatures(opts: { limit: number; until?: string; before?: string }) {
    try {
      return await this.rpc.call<SignatureInfo[]>('getSignaturesForAddress', [this.source, { ...opts, commitment: 'confirmed' }]);
    } catch (e) {
      // public RPC is a pool of nodes: one of them may not know the signature we count from
      if (opts.until && /not found/i.test(String(e instanceof Error ? e.message : e))) {
        this.state = { initialized: false, lastSignature: null };
        return [];
      }
      throw e;
    }
  }

  async poll() {
    if (!this.state.initialized) {
      const [newest] = await this.signatures({ limit: 1 });
      this.state = { initialized: true, lastSignature: newest?.signature ?? null };
      return;
    }
    const fresh: SignatureInfo[] = [];
    for (let before: string | undefined; ;) {
      const page = await this.signatures({ limit: this.pageSize, until: this.state.lastSignature ?? undefined, before });
      fresh.push(...page);
      if (page.length < this.pageSize) break;
      before = page[page.length - 1].signature;
    }
    for (const s of fresh.reverse()) {
      if (s.err) { this.state = { initialized: true, lastSignature: s.signature }; continue; }
      const tx = await this.transaction(s.signature);
      if (!tx) return; // not served yet; retry from here next poll
      this.state = { initialized: true, lastSignature: s.signature };
      if (this.mint && !touchesMint(tx, this.mint)) continue;
      const lamports = this.wallets.reduce((sum, w) => sum + inflowFromTx(tx, w), 0);
      if (lamports > 0) this.onFee({ signature: s.signature, lamports, slot: tx.slot, blockTime: tx.blockTime });
    }
  }

  private async transaction(signature: string): Promise<TxJson | null> {
    const get = () => this.rpc.call<TxJson | null>('getTransaction', [signature, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: this.txVersion }]);
    try { return await get(); } catch (e) {
      // e.g. 'Transaction version (2) is not supported ... "maxSupportedTransactionVersion": 2'
      const newer = Number(String(e instanceof Error ? e.message : e).match(/maxSupportedTransactionVersion"?:\s*(\d+)/)?.[1]);
      if (!(newer > this.txVersion)) throw e;
      this.txVersion = newer;
      return get();
    }
  }

  start(intervalMs: number, log: (msg: string) => void = console.error) { return pollForever(() => this.poll(), intervalMs, log); }
}
