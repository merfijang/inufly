// The dog's controller: eyes → connectome → three readouts (left, right, jump) → action.
// The decision sees the game only through the neurons; θ (weights + a bias per readout) is the
// only thing that learns.
import type { Action, RunnerGame } from '../game/runner';
import type { Connectome, NeuronMeta } from './connectome';
import { groupsByName, readRates, readSenses, sense, TRACE_KEEP, type SensoryGroups } from './sensing';

export const ACTIONS: readonly Action[] = ['left', 'right', 'jump'];

/**
 * Which groups the actions are read from, and how their rates are scaled. `heads[a]` lists the
 * indices into `names` that action `a` (in ACTIONS order) reads.
 */
export interface Readout { names: string[]; mean: number[]; std: number[]; heads: number[][] }

export const paramCount = (r: Readout) => r.heads.reduce((n, h) => n + h.length + 1, 0);

/** Lane changes closer together than this are ignored: a command, not a twitch. */
export const LANE_COOLDOWN_MS = 300;

export interface Decision { action: Action | null; p: [number, number, number] }

export class NeuralPolicy {
  private readonly ids: Int32Array[];
  private readonly rates: Float32Array;
  private readonly traces: Float32Array;
  readonly features: Float32Array;
  private theta: number[];
  private lastLaneMs = -Infinity;

  constructor(private readonly brain: Connectome, private readonly groups: SensoryGroups, readonly readout: Readout, meta: NeuronMeta = brain.meta) {
    this.ids = groupsByName(meta, readout.names);
    const n = readout.names.length;
    this.rates = new Float32Array(n); this.traces = new Float32Array(n); this.features = new Float32Array(n);
    this.theta = new Array(paramCount(readout)).fill(0);
  }

  /** Start a fresh attempt: new readout parameters, reset membrane state and noise seed. */
  begin(theta: number[], seed: number) {
    if (theta.length !== paramCount(this.readout)) throw new Error(`theta needs ${paramCount(this.readout)} values, got ${theta.length}`);
    this.theta = [...theta];
    this.brain.reset(seed); this.traces.fill(0); this.features.fill(0); this.lastLaneMs = -Infinity;
  }

  /** One 20 ms step while running: sense, step the brain, read the three outputs, pick at most one. */
  tick(game: RunnerGame, nowMs: number): Decision {
    sense(this.brain, this.groups, readSenses(game));
    this.brain.step();
    readRates(this.brain, this.ids, this.rates);
    const { mean, std, heads } = this.readout;
    for (let k = 0; k < this.rates.length; k++) {
      this.traces[k] = TRACE_KEEP * this.traces[k] + (1 - TRACE_KEEP) * this.rates[k];
      this.features[k] = (this.traces[k] - mean[k]) / Math.max(0.02, std[k]);
    }
    const p: [number, number, number] = [0, 0, 0];
    let at = 0, best = -1;
    heads.forEach((head, a) => {
      let z = this.theta[at + head.length];
      head.forEach((k, j) => { z += this.theta[at + j] * this.features[k]; });
      at += head.length + 1;
      p[a] = 1 / (1 + Math.exp(-z));
      if (p[a] >= 0.5 && (best < 0 || p[a] > p[best])) best = a;
    });
    let action: Action | null = best < 0 ? null : ACTIONS[best];
    if (action && action !== 'jump' && nowMs - this.lastLaneMs < LANE_COOLDOWN_MS) action = null;
    if (action && !game.act(action)) action = null;
    if (action && action !== 'jump') this.lastLaneMs = nowMs;
    return { action, p };
  }

  get readoutCells() { return this.ids; }

  /** One 20 ms step with no sensory input (between attempts): spontaneous activity only. */
  idle() { this.brain.step(); }
}
