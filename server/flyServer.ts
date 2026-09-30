// The one shared fly-dog. Two clocks:
//  - compute: paid attempts run through the connectome as fast as the CPU allows, several at a
//    time (the samples of one ES generation are independent), each recorded step by step;
//  - playback: those recordings stream to viewers at exactly real time, one step per 20 ms,
//    with a short pause between runs.
// Learning happens when an attempt finishes computing; viewers see it a little later.
import type { Readout } from '../src/core/policy';
import type { Course } from '../src/game/runner';
import { DEFAULT_COURSE } from '../src/game/runner';
import type { AttemptRecord, AttemptStart, Frame, ServerMessage, Stats } from '../src/shared/protocol';
import { ACTIVITY_EVERY, type AttemptResult, type AttemptRunner } from './attempt';
import type { Computer } from './computePool';
import { FeeAccumulator } from './fees/accumulator';
import type { FeeEvent, WatcherCursor } from './fees/solanaWatcher';
import { initialTrainer, Trainer, type Sample, type TrainerState } from './trainer';

export { ACTIVITY_EVERY };

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
  /** runs the attempts */ computer: Computer;
  /** the main thread's brain: spontaneous activity between runs, for the neuron map */ idle: AttemptRunner;
  state: PersistedState; lamportsPerAttempt: number;
  feeSource: Stats['feeSource']; feeWallets: string[];
  save: (s: PersistedState) => void; out: Outbox;
  rand?: () => number; capSeconds?: number; pauseTicks?: number; historyLimit?: number; course?: Course;
  /** runs computed ahead of the one playing; more only costs memory */ ahead?: number;
  onError?: (e: unknown) => void;
}

const RETRY_MS = 5000;

/** One computed attempt, ready to play. */
interface Recording { start: AttemptStart; frames: Frame[]; activity: Uint8Array[]; record: AttemptRecord }

export class FlyServer {
  private readonly state: PersistedState;
  private readonly trainer: Trainer;
  private readonly fees: FeeAccumulator;
  private readonly inflight = new Map<number, Promise<void>>();
  private readonly ready: Recording[] = [];
  private playing: { rec: Recording; step: number } | null = null;
  private pauseLeft = 0; private idleSteps = 0; private nextJob = 1;
  /** seconds of running computed since start (for the health log) */
  computedSeconds = 0;

  constructor(private readonly o: FlyServerOptions) {
    this.state = o.state;
    this.trainer = new Trainer(o.state.trainer, o.rand);
    this.fees = new FeeAccumulator(o.lamportsPerAttempt, o.state.pendingLamports);
  }

  get displayCount() { return this.o.idle.displayCount; }

  stats(): Stats {
    const s = this.state;
    return {
      attempts: s.attempts, generation: s.trainer.generation, queue: this.queued, bestMetres: s.bestMetres,
      totalFeeLamports: s.totalFeeLamports, pendingLamports: this.fees.pending, lamportsPerAttempt: this.o.lamportsPerAttempt,
      feeSource: this.o.feeSource, feeWallets: this.o.feeWallets, running: !!this.playing
    };
  }

  /** Paid attempts viewers have not seen start yet: waiting, being computed, or computed and waiting to play. */
  private get queued() { return this.state.queue + this.inflight.size + this.ready.length; }

  hello(): ServerMessage {
    return {
      type: 'hello', stats: this.stats(), history: this.state.history.slice(-300),
      current: this.playing?.rec.start ?? null, displayCount: this.displayCount, readoutGroups: this.state.readout.names
    };
  }

  /**
   * Snapshot for disk. Attempts being computed count as still queued, so a crash never loses a paid
   * attempt. Computed-but-unplayed ones have already taught the fly and are counted as run.
   */
  snapshot(): PersistedState {
    return { ...this.state, queue: this.state.queue + this.inflight.size, pendingLamports: this.fees.pending };
  }

  setFeeWallets(wallets: string[]) { this.o.feeWallets = wallets; this.o.out.json({ type: 'stats', stats: this.stats() }); }

  /** Attempts given outside the fee flow (a launch push). They queue like any other. */
  grantAttempts(n: number) {
    if (!Number.isInteger(n) || n <= 0 || n > 10000) throw new Error(`grant 1 to 10000 attempts, got ${n}`);
    this.state.queue += n;
    this.o.save(this.snapshot());
    this.o.out.json({ type: 'stats', stats: this.stats() });
    this.pump();
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
    this.pump();
  }

  /**
   * Start as many paid attempts as there are free compute slots, as far as the current generation
   * allows (the next generation's samples depend on this one's results) and without piling up
   * more finished runs than playback needs.
   */
  pump() {
    const ahead = this.o.ahead ?? this.o.computer.size + 1;
    while (this.state.queue > 0 && this.inflight.size < this.o.computer.size && this.ready.length + this.inflight.size < ahead && this.trainer.canIssue()) {
      this.state.queue--;
      const sample = this.trainer.next(), id = this.nextJob++;
      let failed = false;
      const done = this.o.computer.run({ id, theta: sample.theta, seed: sample.seed, course: this.o.course, capSeconds: this.o.capSeconds ?? 180 })
        .then((r) => this.finish(sample, r))
        .catch((e) => { failed = true; this.state.queue++; this.trainer.unissue(sample.index); this.o.onError?.(e); })
        .finally(() => {
          this.inflight.delete(id);
          // after a failure, wait before trying again rather than spinning on a broken worker
          if (failed) setTimeout(() => this.pump(), RETRY_MS).unref?.(); else this.pump();
        });
      this.inflight.set(id, done);
    }
  }

  /** Resolves once nothing is being computed and nothing more can be started (tests). */
  async settle() {
    this.pump();
    while (this.inflight.size) { await Promise.all(this.inflight.values()); this.pump(); }
  }

  /** One 20 ms step of playback for viewers. When nothing plays, the idle brain keeps the neuron map alive. */
  playTick(idleBrain = true) {
    if (this.pauseLeft > 0) this.pauseLeft--;
    if (!this.playing && !this.pauseLeft && this.ready.length) {
      this.playing = { rec: this.ready.shift()!, step: 0 };
      this.o.out.json(this.playing.rec.start);
      this.o.out.json({ type: 'stats', stats: this.stats() });
      this.pump();
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
    } else if (idleBrain) {
      // between runs: spontaneous activity only
      const bits = this.o.idle.idle(this.idleSteps++);
      if (bits) this.o.out.binary(bits);
    }
  }

  private finish(sample: Sample, r: AttemptResult) {
    const s = this.state;
    this.trainer.report(sample.index, r.metres);
    this.computedSeconds += r.seconds;
    s.attempts++;
    s.bestMetres = Math.max(s.bestMetres, r.metres);
    const start: AttemptStart = {
      type: 'attempt_start', n: s.attempts, generation: sample.generation, sample: sample.index, pop: s.trainer.pop,
      seed: sample.seed, course: this.o.course ?? DEFAULT_COURSE
    };
    const record: AttemptRecord = { n: s.attempts, generation: sample.generation, metres: r.metres, seconds: r.seconds, cause: r.cause, at: Date.now() };
    s.history.push(record);
    const limit = this.o.historyLimit ?? 2000;
    if (s.history.length > limit) s.history.splice(0, s.history.length - limit);
    this.ready.push({ start, frames: r.frames, activity: r.activity, record });
    this.o.save({ ...this.snapshot(), queue: this.state.queue + this.inflight.size - 1 });
  }
}
