// The one shared fly-dog. Two clocks:
//  - compute: runs paid attempts through the connectome as fast as the CPU it is given allows
//    (the box is shared with FlappyFly, so this process runs at low priority and may fall behind
//    real time), recording every step;
//  - playback: streams those recordings to viewers at exactly real time, one step per 20 ms.
// Learning happens when an attempt finishes computing; viewers see it a little later.
import type { Connectome } from '../src/core/connectome';
import { NeuralPolicy, type Readout } from '../src/core/policy';
import type { SensoryGroups } from '../src/core/sensing';
import { STEP_SECONDS } from '../src/core/pace';
import { DEFAULT_COURSE, RunnerGame, type Course } from '../src/game/runner';
import { pickDisplayNeurons } from '../src/shared/display';
import { encodeBits, type AttemptRecord, type AttemptStart, type Frame, type ServerMessage, type Stats } from '../src/shared/protocol';
import { FeeAccumulator } from './fees/accumulator';
import type { FeeEvent, WatcherCursor } from './fees/solanaWatcher';
import { initialTrainer, Trainer, type Sample, type TrainerState } from './trainer';

export interface PersistedState {
  /** 2: Subway Surfers obstacles, four moves (left, right, jump, roll). */
  version: 2; trainer: TrainerState; readout: Readout;
  queue: number; pendingLamports: number; totalFeeLamports: number;
  attempts: number; bestMetres: number;
  watchers: Record<string, WatcherCursor>; balances: Record<string, number>; history: AttemptRecord[];
}

export function freshState(readout: Readout, theta: number[]): PersistedState {
  return {
    version: 2, trainer: initialTrainer(theta), readout,
    queue: 0, pendingLamports: 0, totalFeeLamports: 0, attempts: 0, bestMetres: 0, watchers: {}, balances: {}, history: []
  };
}

export interface WatchPosition { cursor?: WatcherCursor; balance?: number | null }

export interface Outbox { json(msg: ServerMessage): void; binary(bytes: Uint8Array): void }

export interface FlyServerOptions {
  brain: Connectome; groups: SensoryGroups; state: PersistedState; lamportsPerAttempt: number;
  feeSource: Stats['feeSource']; feeWallets: string[];
  save: (s: PersistedState) => void; out: Outbox;
  rand?: () => number; capSeconds?: number; pauseTicks?: number; historyLimit?: number; course?: Course;
  /** recordings computed ahead of the one playing; more only costs memory */ ahead?: number;
}

/** Activity goes out every this many steps (10 Hz). */
export const ACTIVITY_EVERY = 5;

/** One computed attempt, ready to play. `activity[k]` belongs to step (k + 1) * ACTIVITY_EVERY - 1. */
interface Recording { start: AttemptStart; frames: Frame[]; activity: Uint8Array[]; record: AttemptRecord }

interface Computing { sample: Sample; game: RunnerGame; rec: Recording; step: number }

export class FlyServer {
  private readonly state: PersistedState;
  private readonly policy: NeuralPolicy;
  private readonly trainer: Trainer;
  private readonly fees: FeeAccumulator;
  private readonly displayIndexOf: Int32Array;
  private readonly hits: Uint8Array;
  private computing: Computing | null = null;
  private readonly ready: Recording[] = [];
  private playing: { rec: Recording; step: number } | null = null;
  private pauseLeft = 0; private idleSteps = 0;

  constructor(private readonly o: FlyServerOptions) {
    this.state = o.state;
    this.policy = new NeuralPolicy(o.brain, o.groups, o.state.readout);
    this.trainer = new Trainer(o.state.trainer, o.rand);
    this.fees = new FeeAccumulator(o.lamportsPerAttempt, o.state.pendingLamports);
    const display = pickDisplayNeurons(o.brain.meta, o.state.readout.names);
    this.displayIndexOf = new Int32Array(o.brain.n).fill(-1);
    display.ids.forEach((id, k) => { this.displayIndexOf[id] = k; });
    this.hits = new Uint8Array(display.ids.length);
  }

  get displayCount() { return this.hits.length; }

  stats(): Stats {
    const s = this.state;
    return {
      attempts: s.attempts, generation: s.trainer.generation, queue: this.queued, bestMetres: s.bestMetres,
      totalFeeLamports: s.totalFeeLamports, pendingLamports: this.fees.pending, lamportsPerAttempt: this.o.lamportsPerAttempt,
      feeSource: this.o.feeSource, feeWallets: this.o.feeWallets, running: !!this.playing
    };
  }

  /** Paid attempts viewers have not seen start yet: waiting, being computed, or computed and waiting to play. */
  private get queued() { return this.state.queue + (this.computing ? 1 : 0) + this.ready.length; }

  hello(): ServerMessage {
    return {
      type: 'hello', stats: this.stats(), history: this.state.history.slice(-300),
      current: this.playing?.rec.start ?? null, displayCount: this.displayCount, readoutGroups: this.state.readout.names
    };
  }

  /**
   * Snapshot for disk. An attempt being computed counts as still queued, so a crash never loses a
   * paid attempt. Computed-but-unplayed ones have already taught the fly and are counted as flown.
   */
  snapshot(): PersistedState {
    return { ...this.state, queue: this.state.queue + (this.computing ? 1 : 0), pendingLamports: this.fees.pending };
  }

  setFeeWallets(wallets: string[]) { this.o.feeWallets = wallets; this.o.out.json({ type: 'stats', stats: this.stats() }); }

  /** Attempts given outside the fee flow (a launch push). They queue like any other. */
  grantAttempts(n: number) {
    if (!Number.isInteger(n) || n <= 0 || n > 10000) throw new Error(`grant 1 to 10000 attempts, got ${n}`);
    this.state.queue += n;
    this.o.save(this.snapshot());
    this.o.out.json({ type: 'stats', stats: this.stats() });
    return this.queued;
  }

  setWatcher(wallet: string, at: WatchPosition) {
    if (at.cursor) this.state.watchers[wallet] = at.cursor;
    if (at.balance !== undefined && at.balance !== null) this.state.balances[wallet] = at.balance;
  }

  addFee(e: FeeEvent, from?: { wallet: string } & WatchPosition) {
    const added = this.fees.add(e.lamports);
    this.state.totalFeeLamports += Math.max(0, e.lamports);
    this.state.queue += added;
    if (from) this.setWatcher(from.wallet, from);
    this.o.save(this.snapshot());
    this.o.out.json({ type: 'fee', lamports: e.lamports, signature: e.signature, attemptsAdded: added });
    this.o.out.json({ type: 'stats', stats: this.stats() });
  }

  /** Is there anything for the compute clock to do? */
  get wantsCompute() { return !!this.computing || (this.state.queue > 0 && this.ready.length < (this.o.ahead ?? 1)); }

  /** Advance the attempt being computed by one brain step (starting one if one is paid for). */
  computeStep() {
    if (!this.computing) {
      if (!this.wantsCompute) return;
      this.startCompute();
    }
    const c = this.computing!, g = c.game;
    const { action, p } = this.policy.tick(g, g.state.t * 1000);
    g.update(STEP_SECONDS);
    const s = g.state;
    const frame: Frame = { type: 'frame', t: +s.t.toFixed(2), z: +s.z.toFixed(2), x: +s.x.toFixed(3), y: +s.y.toFixed(2), p: p.map((q) => +q.toFixed(3)) };
    if (g.rolling) frame.c = 1;
    if (action) frame.a = action;
    c.rec.frames.push(frame);
    this.collect(c.rec.activity, c.step);
    c.step++;
    const cap = this.o.capSeconds ?? 180;
    if (!s.alive || s.t >= cap) this.finishCompute(s.cause ?? 'Ran out the clock.');
  }

  /** One 20 ms step of playback for viewers. When nothing plays, the idle brain keeps the neuron map alive. */
  playTick(idleBrain = true) {
    if (this.pauseLeft > 0) this.pauseLeft--;
    if (!this.playing && !this.pauseLeft && this.ready.length) {
      this.playing = { rec: this.ready.shift()!, step: 0 };
      this.o.out.json(this.playing.rec.start);
      this.o.out.json({ type: 'stats', stats: this.stats() });
    }
    const p = this.playing;
    if (p) {
      const { frames, activity, record } = p.rec;
      this.o.out.json(frames[p.step]);
      if ((p.step + 1) % ACTIVITY_EVERY === 0 && activity[(p.step + 1) / ACTIVITY_EVERY - 1]) this.o.out.binary(activity[(p.step + 1) / ACTIVITY_EVERY - 1]);
      if (++p.step >= frames.length) {
        this.playing = null; this.pauseLeft = this.o.pauseTicks ?? 100;
        this.o.out.json({ type: 'attempt_end', record });
        this.o.out.json({ type: 'stats', stats: this.stats() });
      }
    } else if (idleBrain && !this.computing) {
      // between attempts: spontaneous activity only, and only when the brain is not busy computing
      this.policy.idle();
      this.collect(null, this.idleSteps++);
    }
  }

  private startCompute() {
    this.state.queue--;
    const sample = this.trainer.next(), game = new RunnerGame(sample.seed, this.o.course ?? DEFAULT_COURSE);
    this.policy.begin(sample.theta, sample.seed);
    this.hits.fill(0);
    const start: AttemptStart = {
      type: 'attempt_start', n: this.state.attempts + this.ready.length + 1, generation: sample.generation,
      sample: sample.index, pop: this.state.trainer.pop, seed: sample.seed, course: game.course
    };
    this.computing = { sample, game, step: 0, rec: { start, frames: [], activity: [], record: null! } };
  }

  private finishCompute(cause: string) {
    const c = this.computing!, s = this.state, g = c.game.state;
    const metres = +g.z.toFixed(1);
    this.trainer.report(c.sample.index, metres);
    s.attempts++;
    s.bestMetres = Math.max(s.bestMetres, metres);
    c.rec.record = { n: c.rec.start.n, generation: c.sample.generation, metres, seconds: +g.t.toFixed(2), cause, at: Date.now() };
    s.history.push(c.rec.record);
    const limit = this.o.historyLimit ?? 2000;
    if (s.history.length > limit) s.history.splice(0, s.history.length - limit);
    this.ready.push(c.rec);
    this.computing = null;
    this.o.save(this.snapshot());
  }

  /** Mark which display neurons fired this step; every ACTIVITY_EVERY steps, pack them into `into` or send them live. */
  private collect(into: Uint8Array[] | null, step: number) {
    for (const id of this.o.brain.lastFired()) { const k = this.displayIndexOf[id]; if (k >= 0) this.hits[k] = 1; }
    if ((step + 1) % ACTIVITY_EVERY) return;
    const bits = encodeBits(this.hits);
    if (into) into.push(bits); else this.o.out.binary(bits);
    this.hits.fill(0);
  }
}
