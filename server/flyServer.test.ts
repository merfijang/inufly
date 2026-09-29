import { describe, expect, it } from 'vitest';
import { buildGroups } from '../src/core/sensing';
import { tinyBrain } from '../src/core/testing';
import type { ServerMessage } from '../src/shared/protocol';
import { FlyServer, freshState, type PersistedState } from './flyServer';

const readout = { names: ['DNp01 L', 'DNa02 L', 'DNa02 R'], mean: [0, 0, 0], std: [1, 1, 1], heads: [[1], [2], [0]] };
const quiet = [0, -20, 0, -20, 0, -20];

function setup(extra: Partial<ConstructorParameters<typeof FlyServer>[0]> = {}) {
  const brain = tinyBrain(), msgs: ServerMessage[] = [], bins: Uint8Array[] = [], saves: PersistedState[] = [];
  let r = 5; const rand = () => (r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 4294967296;
  const fly = new FlyServer({
    brain, groups: buildGroups(brain.meta), state: freshState(readout, quiet), lamportsPerAttempt: 100, feeSource: 'mock', feeWallets: [],
    save: (s) => saves.push(structuredClone(s)), out: { json: (m) => msgs.push(m), binary: (b) => bins.push(b) }, rand, ...extra
  });
  const of = <T extends ServerMessage['type']>(t: T) => msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === t);
  const computeAll = () => { for (let i = 0; i < 100000 && fly.wantsCompute; i++) fly.computeStep(); };
  return { fly, msgs, bins, saves, of, computeAll };
}
const fee = (lamports: number) => ({ signature: `s${lamports}`, lamports, slot: 0, blockTime: null });

describe('FlyServer', () => {
  it('turns fees into queued attempts and persists them', () => {
    const { fly, saves, of } = setup();
    fly.addFee(fee(250));
    expect(fly.stats()).toMatchObject({ queue: 2, pendingLamports: 50, totalFeeLamports: 250 });
    expect(saves.at(-1)).toMatchObject({ queue: 2, pendingLamports: 50 });
    expect(of('fee')[0]).toMatchObject({ attemptsAdded: 2 });
  });

  it('computes a paid attempt, learns from it, then plays it back step by step', () => {
    const { fly, of, saves, computeAll } = setup({ pauseTicks: 3 });
    expect(fly.wantsCompute).toBe(false);
    fly.addFee(fee(100));
    computeAll();
    expect(fly.stats()).toMatchObject({ attempts: 1, queue: 1, running: false }); // computed, not yet shown
    expect(saves.at(-1)!.history).toHaveLength(1);
    expect(of('attempt_start')).toHaveLength(0);
    fly.playTick();
    expect(of('attempt_start')[0]).toMatchObject({ n: 1, generation: 0, sample: 0, pop: 10 });
    for (let i = 0; i < 100000 && !of('attempt_end').length; i++) fly.playTick();
    const end = of('attempt_end')[0], frames = of('frame');
    expect(frames.length).toBe(Math.round(end.record.seconds / 0.02));
    expect(end.record.metres).toBeGreaterThan(40); // the first obstacle is 45 m out; a silent dog hits it
    expect(end.record.metres).toBe(Math.round(frames.at(-1)!.z * 10) / 10);
    expect(fly.stats()).toMatchObject({ queue: 0, running: false });
  });

  it('computes at most one attempt ahead of the one playing', () => {
    const { fly, computeAll } = setup();
    fly.addFee(fee(300));
    computeAll();
    expect(fly.stats()).toMatchObject({ attempts: 1, queue: 3 });
    fly.playTick(); // starts playing it
    computeAll();
    expect(fly.stats().attempts).toBe(2);
  });

  it('counts an attempt being computed as still queued when saving', () => {
    const { fly } = setup();
    fly.addFee(fee(200));
    fly.computeStep();
    expect(fly.stats().queue).toBe(2);
    expect(fly.snapshot().queue).toBe(2);
  });

  it('ends an attempt at the time cap', () => {
    const { fly, of, computeAll } = setup({ capSeconds: 0.1, pauseTicks: 0 });
    fly.addFee(fee(100)); computeAll();
    for (let i = 0; i < 10; i++) fly.playTick();
    expect(of('attempt_end')[0].record).toMatchObject({ seconds: 0.1, cause: 'Ran out the clock.' });
  });

  it('plays back activity every 5 steps, and idles the brain only when asked', () => {
    const { fly, bins, computeAll } = setup({ capSeconds: 0.2, pauseTicks: 0 });
    for (let i = 0; i < 10; i++) fly.playTick(false);
    expect(bins).toHaveLength(0);
    for (let i = 0; i < 10; i++) fly.playTick(true);
    expect(bins).toHaveLength(2);
    expect(bins[0].length).toBe(Math.ceil(fly.displayCount / 8));
    fly.addFee(fee(100)); computeAll();
    bins.length = 0;
    for (let i = 0; i < 10; i++) fly.playTick(false);
    expect(bins).toHaveLength(2);
  });

  it('can be handed attempts outside the fee flow, and refuses silly numbers', () => {
    const { fly, saves } = setup();
    expect(fly.grantAttempts(20)).toBe(20);
    expect(saves.at(-1)!.queue).toBe(20);
    expect(() => fly.grantAttempts(0)).toThrow();
    expect(() => fly.grantAttempts(2.5)).toThrow();
    expect(() => fly.grantAttempts(50_000)).toThrow();
  });

  it('persists fee watcher positions with each fee', () => {
    const { fly, saves } = setup();
    fly.addFee(fee(100), { wallet: 'VaultA', cursor: { initialized: true, lastSignature: 'sigA' } });
    fly.addFee(fee(100), { wallet: 'VaultB', balance: 12345 });
    expect(saves.at(-1)!.watchers).toEqual({ VaultA: { initialized: true, lastSignature: 'sigA' } });
    expect(saves.at(-1)!.balances).toEqual({ VaultB: 12345 });
  });

  it('keeps only the most recent history', () => {
    const { fly, saves, computeAll } = setup({ capSeconds: 0.02, pauseTicks: 0, historyLimit: 3 });
    fly.addFee(fee(500));
    for (let i = 0; i < 20; i++) { computeAll(); fly.playTick(false); }
    expect(saves.at(-1)!.history.map((h) => h.n)).toEqual([3, 4, 5]);
  });
});
