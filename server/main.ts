// Entry point: `npm run server`. Loads the connectome, restores learning state, starts fees, the
// compute loop (as fast as it is allowed) and the 50 Hz playback loop.
import { buildGroups } from '../src/core/sensing';
import { readFileSync } from 'node:fs';
import { calibrateReadout, initialTheta } from '../src/core/calibrate';
import { ACTIONS } from '../src/core/policy';
import { loadBrain } from './brainFiles';
import { Broadcaster } from './broadcast';
import { readConfig } from './config';
import { mockFees } from './fees/mockSource';
import { BalanceFeeWatcher } from './fees/balanceWatcher';
import { httpRpc, SolanaFeeWatcher, type FeeEvent } from './fees/solanaWatcher';
import { resolvePumpCoin } from './fees/pumpToken';
import { FlyServer, freshState, type PersistedState } from './flyServer';
import { loadState, saveState } from './stateStore';

const cfg = readConfig();
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

log('loading connectome from', cfg.brainDir);
const brain = loadBrain(cfg.brainDir), groups = buildGroups(brain.meta);
log(`connectome ready: ${brain.n.toLocaleString()} neurons`);

// a state file from an older version of the game: the learning does not carry over, the money does
const older = (() => { try { const s = JSON.parse(readFileSync(cfg.stateFile, 'utf8')); return s?.version !== 2 ? s as Partial<PersistedState> : null; } catch { return null; } })();
let state = loadState<PersistedState>(cfg.stateFile, () => ({ version: 2 }) as PersistedState);
if (!state.trainer || !state.readout) {
  log('first start: measuring which neurons to read left, right, jump and roll from (~1 min)');
  const cal = calibrateReadout(brain, groups, brain.meta, { perHead: cfg.perAction });
  ACTIONS.forEach((a, h) => log(`${a}: ${cal.readout.heads[h].map((k) => cal.readout.names[k]).join(', ')}`));
  state = freshState(cal.readout, initialTheta(cal));
  if (older) {
    const { queue = 0, pendingLamports = 0, totalFeeLamports = 0, watchers = {}, balances = {} } = older;
    Object.assign(state, { queue, pendingLamports, totalFeeLamports, watchers, balances });
    log(`carried over from the previous game: ${queue} paid attempts, ${totalFeeLamports / 1e9} SOL of fees, fee watcher positions`);
  }
  saveState(cfg.stateFile, state);
}
log(`state: ${state.attempts} attempts, generation ${state.trainer.generation}, queue ${state.queue}`);

const rpc = httpRpc(cfg.rpcUrl);

/** The coin can be named before it exists: keep asking pump.fun until the launch lands. */
async function waitForCoin(mint: string) {
  for (let tries = 0; ; tries++) {
    try { return await resolvePumpCoin(rpc, mint); }
    catch (e) {
      if (!tries) log(`${mint} is not on pump.fun yet — waiting for the launch (${e instanceof Error ? e.message.split(' — ')[0] : e})`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}

// resolve before the server starts when the coin is already live, so its vaults are in the first stats
let coin = cfg.feeSource === 'solana' && cfg.feeToken ? await resolvePumpCoin(rpc, cfg.feeToken).catch(() => null) : null;
if (coin) cfg.feeWallets = coin.vaults;

let fly: FlyServer | undefined;
const out = new Broadcaster(
  { hello: () => fly!.hello(), stats: () => fly!.stats(), grant: (n) => fly!.grantAttempts(n) },
  cfg.corsOrigin, cfg.adminToken
);
state.watchers ??= {}; state.balances ??= {};
fly = new FlyServer({
  brain, groups, state, lamportsPerAttempt: cfg.lamportsPerAttempt, feeSource: cfg.feeSource, feeWallets: cfg.feeWallets,
  save: (s) => saveState(cfg.stateFile, s), out, capSeconds: cfg.capSeconds
});

let stopFees: () => void = () => undefined;
if (cfg.feeSource === 'mock') {
  stopFees = mockFees(cfg.mockFeeEveryMs, (e) => fly!.addFee(e), Math.random, cfg.mockTotalLamports);
  log(`fees: MOCK, one fake inflow every ${cfg.mockFeeEveryMs} ms${Number.isFinite(cfg.mockTotalLamports) ? `, ${cfg.mockTotalLamports / 1e9} SOL in total` : ''}`);
} else {
  const stops: (() => void)[] = [];
  stopFees = () => stops.forEach((stop) => stop());
  const watchAll = () => {
  // one coin: walk that coin trades once and credit every vault it paid. Otherwise: one watcher per vault.
  const groups: string[][] = cfg.feeMint ? [cfg.feeWallets] : cfg.feeWallets.map((w) => [w]);
  for (const wallets of groups) {
    const wallet = cfg.feeMint ? `mint:${cfg.feeMint}` : wallets[0];
    const position = () => (watcher instanceof BalanceFeeWatcher ? { balance: watcher.lastBalance } : { cursor: watcher.cursor });
    const onFee = (e: FeeEvent) => { log('fee', e.lamports / 1e9, 'SOL into', wallet, e.signature); fly!.addFee(e, { wallet, ...position() }); };
    const watcher: BalanceFeeWatcher | SolanaFeeWatcher = cfg.feeMode === 'balance'
      ? new BalanceFeeWatcher(rpc, wallets[0], state.balances[wallet] ?? null, onFee)
      : new SolanaFeeWatcher(rpc, wallets, state.watchers[wallet] ?? null, onFee, { mint: cfg.feeMint });
    // the first poll may only record a baseline; persist that before watching
    void watcher.poll()
      .then(() => { fly!.setWatcher(wallet, position()); saveState(cfg.stateFile, fly!.snapshot()); })
      .catch((e) => log(`first fee poll of ${wallet} failed, retrying in the loop:`, e instanceof Error ? e.message : e))
      .finally(() => { stops.push(watcher.start(cfg.pollMs, (m) => log(m))); });
  }
    log(`fees: watching ${cfg.feeWallets.join(', ')} (${cfg.feeMode}, every ${cfg.pollMs} ms${cfg.feeMint ? `, only trades of ${cfg.feeMint}` : ''}) via ${cfg.rpcUrl}`);
  };

  const announce = (c: NonNullable<typeof coin>) => {
    log(`coin ${c.mint}: creator ${c.creator}, ${c.migrated ? 'trading on PumpSwap' : 'still on the bonding curve'}`);
    log(`fee vaults: ${c.vaults.join(', ')}`);
    if (cfg.feeMode === 'balance') log('counting everything that lands in those vaults: if this creator made other coins, their fees count too (FEE_MINT counts one coin, at a request per trade)');
  };

  if (cfg.feeToken && !coin) {
    // the coin is not live yet: fly on granted attempts meanwhile, start counting the moment it launches
    void waitForCoin(cfg.feeToken).then((found) => {
      coin = found; cfg.feeWallets = found.vaults;
      fly!.setFeeWallets(found.vaults);
      announce(found);
      watchAll();
    });
  } else {
    if (coin) announce(coin);
    watchAll();
  }
}
log(`1 attempt = ${cfg.lamportsPerAttempt / 1e9} SOL`);

// playback: fixed 50 Hz; catch up at most 5 steps, drop further lag rather than spiral.
// The idle brain between attempts only runs for someone watching: the CPU is shared with FlappyFly.
let next = performance.now(), running = true, computeMs = 0, computed = 0;
const playback = () => {
  if (!running) return;
  const now = performance.now();
  for (let n = 0; now >= next && n < 5; n++) { fly!.playTick(out.viewers > 0); next += 20; }
  if (now - next > 200) next = now;
  setTimeout(playback, Math.max(0, next - performance.now()));
};
// compute: brain steps in slices of at most 12 ms, so playback timers still fire on time
const compute = () => {
  if (!running) return;
  const t0 = performance.now();
  while (fly!.wantsCompute && performance.now() - t0 < 12) { fly!.computeStep(); computed++; }
  computeMs += performance.now() - t0;
  setTimeout(compute, fly!.wantsCompute ? 0 : 100);
};
// one health line a minute: how fast attempts compute compared to real time, and who is watching
setInterval(() => {
  const s = fly!.stats();
  if (computed) log(`computed ${computed} steps at ${(computeMs / computed).toFixed(1)} ms each (${((computed * 20) / 60_000).toFixed(2)}× real time)`);
  log(`${out.viewers} viewers, attempts ${s.attempts}, queue ${s.queue}, generation ${s.generation}, best ${s.bestMetres} m`);
  computeMs = 0; computed = 0;
}, 60_000).unref();
playback();
compute();

const port = await out.listen(cfg.port, cfg.host);
log(`listening on ${cfg.host}:${port} (ws /ws, GET /health, GET /stats)`);

const shutdown = async () => {
  running = false; stopFees();
  saveState(cfg.stateFile, fly!.snapshot());
  await out.close();
  log('state saved, bye');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
