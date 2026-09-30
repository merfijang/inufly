// One attempt, start to finish: the dog runs a course with a given readout θ, and every step is
// recorded for playback. Pure apart from the brain it steps; run in worker threads (computePool.ts).
import type { Connectome } from '../src/core/connectome';
import { NeuralPolicy, type Readout } from '../src/core/policy';
import { STEP_SECONDS } from '../src/core/pace';
import type { SensoryGroups } from '../src/core/sensing';
import { DEFAULT_COURSE, RunnerGame, type Course } from '../src/game/runner';
import { pickDisplayNeurons } from '../src/shared/display';
import { encodeBits, type Frame } from '../src/shared/protocol';

/** Activity goes out every this many steps (10 Hz). */
export const ACTIVITY_EVERY = 5;

export interface Job { id: number; theta: number[]; seed: number; course?: Course; capSeconds: number }

/** `activity[k]` holds the display neurons that fired in steps k*5 … k*5+4. */
export interface AttemptResult { id: number; frames: Frame[]; activity: Uint8Array[]; metres: number; seconds: number; cause: string }

/** A brain set up to run attempts: the policy, and which of its neurons the site draws. */
export class AttemptRunner {
  private readonly policy: NeuralPolicy;
  private readonly displayIndexOf: Int32Array;
  private readonly hits: Uint8Array;

  constructor(private readonly brain: Connectome, groups: SensoryGroups, readout: Readout) {
    this.policy = new NeuralPolicy(brain, groups, readout);
    const display = pickDisplayNeurons(brain.meta, readout.names);
    this.displayIndexOf = new Int32Array(brain.n).fill(-1);
    display.ids.forEach((id, k) => { this.displayIndexOf[id] = k; });
    this.hits = new Uint8Array(display.ids.length);
  }

  get displayCount() { return this.hits.length; }

  run(job: Job): AttemptResult {
    const g = new RunnerGame(job.seed, job.course ?? DEFAULT_COURSE), frames: Frame[] = [], activity: Uint8Array[] = [];
    this.policy.begin(job.theta, job.seed);
    this.hits.fill(0);
    for (let step = 0; ; step++) {
      const { action, p } = this.policy.tick(g, g.state.t * 1000);
      g.update(STEP_SECONDS);
      const s = g.state;
      const frame: Frame = { type: 'frame', t: +s.t.toFixed(2), z: +s.z.toFixed(2), x: +s.x.toFixed(3), y: +s.y.toFixed(2), p: p.map((q) => +q.toFixed(3)) };
      if (g.rolling) frame.c = 1;
      if (action) frame.a = action;
      frames.push(frame);
      const bits = this.collect(step);
      if (bits) activity.push(bits);
      if (!s.alive || s.t >= job.capSeconds) {
        return { id: job.id, frames, activity, metres: +s.z.toFixed(1), seconds: +s.t.toFixed(2), cause: s.cause ?? 'Ran out the clock.' };
      }
    }
  }

  /** One step with no sensory input: spontaneous activity, packed every ACTIVITY_EVERY steps. */
  idle(step: number) {
    this.policy.idle();
    return this.collect(step);
  }

  private collect(step: number) {
    for (const id of this.brain.lastFired()) { const k = this.displayIndexOf[id]; if (k >= 0) this.hits[k] = 1; }
    if ((step + 1) % ACTIVITY_EVERY) return null;
    const bits = encodeBits(this.hits);
    this.hits.fill(0);
    return bits;
  }
}
