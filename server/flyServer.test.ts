import { describe, expect, it } from 'vitest';
import { buildGroups } from '../src/core/sensing';
import { tinyBrain } from '../src/core/testing';
import type { ServerMessage } from '../src/shared/protocol';
import { AttemptRunner, type AttemptResult, type Job } from './attempt';
import { InlineComputer, type Computer } from './computePool';
import { FlyServer, freshState, type PersistedState } from './flyServer';

const readout = { names: ['DNp01 L', 'DNa02 L', 'DNa02 R', 'DNa07 L'], mean: [0, 0, 0, 0], std: [1, 1, 1, 1], heads: [[1], [2], [0], [3]] };
const quiet = [0, -20, 0, -20, 0, -20, 0, -20];

function setup(extra: Partial<ConstructorParameters<typeof FlyServer>[0]> = {}) {
  const brain = tinyBrain(), msgs: ServerMessage[] = [], bins: Uint8Array[] = [], saves: PersistedState[] = [];
  let r = 5; const rand = () => (r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 4294967296;
  const runner = new AttemptRunner(brain, buildGroups(brain.meta), readout);
  const fly = new FlyServer({
    computer: new InlineComputer(runner), idle: runner, state: freshState(readout, quiet), lamportsPerAttempt: 100, feeSource: 'mock', feeWallets: [],
    save: (s) => saves.push(structuredClone(s)), out: { json: (m) => msgs.push(m), binary: (b) => bins.push(b) }, rand, ...extra
  });
  const of = <T extends ServerMessage['type']>(t: T) => msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === t);
  return { fly, msgs, bins, saves, of, runner };
}
const fee = (lamports: number) => ({ signature: `s${lamports}`, lamports, slot: 0, blockTime: null });
const playAll = (fly: FlyServer, of: ReturnType<typeof setup>['of'], n = 1) => { for (let i = 0; i < 200000 && of('attempt_end').length < n; i++) fly.playTick(false); };

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

/** A computer with `size` slots whose attempts finish only when the test says so. */
function manualComputer(size: number, runner: AttemptRunner) {
  const jobs: { job: Job; done: (r: AttemptResult) => void }[] = [];
  const computer: Computer = { size, run: (job) => new Promise((done) => jobs.push({ job, done })), close: async () => {} };
  return { computer, jobs, finish: (k = 0) => { const [j] = jobs.splice(k, 1); j.done(runner.run(j.job)); } };
}

describe('FlyServer', () => {
  it('turns fees into queued attempts and persists them', async () => {
    const { fly, saves, of } = setup();
    fly.addFee(fee(250));
    await fly.settle();
    expect(fly.stats()).toMatchObject({ queue: 2, pendingLamports: 50, totalFeeLamports: 250 });
    expect(saves.at(-1)).toMatchObject({ pendingLamports: 50 });
    expect(of('fee')[0]).toMatchObject({ attemptsAdded: 2 });
  });

  it('computes a paid attempt, learns from it, then plays it back step by step', async () => {
    const { fly, of, saves } = setup({ pauseTicks: 3 });
    fly.addFee(fee(100));
    await fly.settle();
    expect(fly.stats()).toMatchObject({ attempts: 1, queue: 1, running: false }); // computed, not yet shown
    expect(saves.at(-1)!.history).toHaveLength(1);
    expect(saves.at(-1)!.queue).toBe(0);
    expect(of('attempt_start')).toHaveLength(0);
    fly.playTick();
    expect(of('attempt_start')[0]).toMatchObject({ n: 1, generation: 0, sample: 0, pop: 10 });
    playAll(fly, of);
    const end = of('attempt_end')[0], frames = of('frame');
    expect(frames.length).toBe(Math.round(end.record.seconds / 0.02));
    expect(end.record.metres).toBeGreaterThan(35); // the first obstacle is 40 m out; a silent dog hits it
    expect(end.record.metres).toBe(Math.round(frames.at(-1)!.z * 10) / 10);
    expect(fly.stats()).toMatchObject({ queue: 0, running: false });
  });

  it('runs as many attempts at once as it has slots, but no further ahead of playback than that', async () => {
    const brain = tinyBrain(), runner = new AttemptRunner(brain, buildGroups(brain.meta), readout), m = manualComputer(3, runner);
    const { fly } = setup({ computer: m.computer, idle: runner });
    fly.addFee(fee(1000));
    expect(m.jobs).toHaveLength(3);
    expect(new Set(m.jobs.map((j) => j.job.seed)).size).toBe(2); // antithetic pairs share a course
    expect(fly.snapshot().queue).toBe(10); // running ones still count as paid-for and waiting
    m.finish(); m.finish(); m.finish();
    await flush();
    expect(m.jobs).toHaveLength(1); // 3 finished + 1 running = 4 = size + 1 ahead
    expect(fly.stats()).toMatchObject({ attempts: 3, queue: 10 });
  });

  it('does not start the next generation before this one is reported', async () => {
    const brain = tinyBrain(), runner = new AttemptRunner(brain, buildGroups(brain.meta), readout), m = manualComputer(20, runner);
    const { fly } = setup({ computer: m.computer, idle: runner, ahead: 50 });
    fly.addFee(fee(1500));
    expect(m.jobs).toHaveLength(10); // one generation
    while (m.jobs.length) { while (m.jobs.length) m.finish(); await flush(); }
    expect(fly.stats()).toMatchObject({ attempts: 15, generation: 1 });
  });

  it('gives an attempt back to the queue if its computation fails', async () => {
    const errors: unknown[] = [];
    const computer: Computer = { size: 1, run: async () => { throw new Error('worker died'); }, close: async () => {} };
    const { fly } = setup({ computer, onError: (e) => errors.push(e) });
    fly.grantAttempts(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(errors).toHaveLength(1);
    expect(fly.snapshot().queue).toBeGreaterThanOrEqual(1);
  });

  it('ends an attempt at the time cap', async () => {
    const { fly, of } = setup({ capSeconds: 0.1, pauseTicks: 0 });
    fly.addFee(fee(100)); await fly.settle();
    for (let i = 0; i < 10; i++) fly.playTick();
    expect(of('attempt_end')[0].record).toMatchObject({ seconds: 0.1, cause: 'Ran out the clock.' });
  });

  it('plays back activity every 5 steps, and idles the brain only when asked', async () => {
    const { fly, bins } = setup({ capSeconds: 0.2, pauseTicks: 0 });
    for (let i = 0; i < 10; i++) fly.playTick(false);
    expect(bins).toHaveLength(0);
    for (let i = 0; i < 10; i++) fly.playTick(true);
    expect(bins).toHaveLength(2);
    expect(bins[0].length).toBe(Math.ceil(fly.displayCount / 8));
    fly.addFee(fee(100)); await fly.settle();
    bins.length = 0;
    for (let i = 0; i < 10; i++) fly.playTick(false);
    expect(bins).toHaveLength(2);
  });

  it('can be handed attempts outside the fee flow, and refuses silly numbers', () => {
    const { fly, saves } = setup();
    fly.grantAttempts(20);
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

  it('keeps only the most recent history', async () => {
    const { fly, saves } = setup({ capSeconds: 0.02, pauseTicks: 0, historyLimit: 3 });
    fly.addFee(fee(500));
    for (let i = 0; i < 20; i++) { await fly.settle(); fly.playTick(false); }
    expect(saves.at(-1)!.history.map((h) => h.n)).toEqual([3, 4, 5]);
  });
});
