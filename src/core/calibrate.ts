// Calibration: show the fly many approaching obstacles, watch every cell type in the brain, and for
// each action keep the populations whose firing follows what that action needs. Those become the
// readout the dog learns on. Seeded, so the same brain always gives the same set.
import type { Connectome, NeuronMeta } from './connectome';
import type { Readout } from './policy';
import { MIN_GROUP_CELLS, readableGroups, readRates, sense, TRACE_KEEP, type Senses, type SensoryGroups } from './sensing';

export interface CalibrationOptions { steps?: number; perHead?: number; seed?: number; minCells?: number }

/** `weights[a]`: the starting weight of each group action `a` reads, in head order. */
export interface Calibration { readout: Readout; weights: number[][] }

const EPISODE = 75; // 1.5 s: one obstacle approaching from the horizon to the dog

/**
 * Each action reads two kinds of population: ones that follow what calls for it (a barrier ahead
 * for the jump, a train ahead for a lane change) and, for a lane change, ones that tell the free
 * side from the blocked one (they follow one side's LPLC2 input more than the other side's).
 * Weights start at the measured correlation, signed so the action is favoured when it is right.
 */
export function calibrateReadout(brain: Connectome, groups: SensoryGroups, meta: NeuronMeta, opts: CalibrationOptions = {}): Calibration {
  const { steps = 4500, perHead = 8, seed = 1, minCells = MIN_GROUP_CELLS } = opts;
  const dn = readableGroups(meta, minCells), G = dn.names.length;
  const Q: ((x: Senses) => number)[] = [(x) => x.barrier, (x) => x.train, (x) => x.leftBlocked, (x) => x.rightBlocked];
  const rates = new Float32Array(G), traces = new Float32Array(G);
  const sum = new Float64Array(G), sq = new Float64Array(G), sxy = Q.map(() => new Float64Array(G));
  const sy = new Float64Array(Q.length), syy = new Float64Array(Q.length);
  let rng = seed >>> 0, n = 0;
  const rand = () => (rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296;
  let kind = 0, left = 0, right = 0;
  brain.reset(seed);
  for (let i = 0; i < steps; i++) {
    const u = (i % EPISODE) / EPISODE;
    if (i % EPISODE === 0) { kind = Math.floor(rand() * 3); left = rand() < 0.5 ? 1 : 0; right = rand() < 0.5 ? 1 : 0; }
    // an obstacle ramps in over the episode; the side lanes are independently free or blocked
    const x: Senses = { barrier: kind === 1 ? u : 0, train: kind === 2 ? u : 0, leftBlocked: left, rightBlocked: right };
    sense(brain, groups, x);
    brain.step(); readRates(brain, dn.ids, rates);
    for (let k = 0; k < G; k++) traces[k] = TRACE_KEEP * traces[k] + (1 - TRACE_KEEP) * rates[k];
    if (i < EPISODE) continue; // let the network settle from rest
    n++;
    Q.forEach((f, q) => { const y = f(x); sy[q] += y; syy[q] += y * y; for (let k = 0; k < G; k++) sxy[q][k] += traces[k] * y; });
    for (let k = 0; k < G; k++) { sum[k] += traces[k]; sq[k] += traces[k] * traces[k]; }
  }
  const mean = Array.from(sum, (s) => s / n), std = Array.from(sq, (s, k) => Math.sqrt(Math.max(0, s / n - mean[k] * mean[k])));
  const live = dn.names.map((_, k) => k).filter((k) => std[k] > 0.003);
  const c = Q.map((_, q) => {
    const my = sy[q] / n, sdy = Math.sqrt(Math.max(1e-9, syy[q] / n - my * my));
    return Float64Array.from(dn.names, (_, k) => (std[k] > 0.003 ? (sxy[q][k] / n - mean[k] * my) / (std[k] * sdy) : 0));
  });
  const [BARRIER, TRAIN, LEFT, RIGHT] = [0, 1, 2, 3];
  /** the `count` live groups scoring highest by |score|, with the score as the starting weight */
  const top = (score: (k: number) => number, count: number, skip = new Set<number>()) =>
    live.filter((k) => !skip.has(k)).sort((a, b) => Math.abs(score(b)) - Math.abs(score(a))).slice(0, count).map((k) => ({ k, w: score(k) }));
  const half = perHead >> 1;
  const trainGroups = top((k) => c[TRAIN][k], half);
  // blocked on the left and not on the right → discourage left; the sign flips for the right head
  const sideGroups = top((k) => c[LEFT][k] - c[RIGHT][k], half, new Set(trainGroups.map((g) => g.k)));
  const picks = [
    [...trainGroups, ...sideGroups.map((g) => ({ k: g.k, w: -g.w }))],
    [...trainGroups, ...sideGroups],
    top((k) => c[BARRIER][k], perHead)
  ];
  const names: string[] = [], index = new Map<number, number>();
  const heads = picks.map((gs) => gs.map((g) => {
    if (!index.has(g.k)) { index.set(g.k, names.length); names.push(dn.names[g.k]); }
    return index.get(g.k)!;
  }));
  const at = [...index.keys()];
  return { readout: { names, heads, mean: at.map((k) => mean[k]), std: at.map((k) => Math.max(0.02, std[k])) }, weights: picks.map((gs) => gs.map((g) => g.w)) };
}

/**
 * The starting θ: each group weighted by how well it followed its action's cue at calibration, and
 * a bias that keeps the dog from acting on nothing. Everything after this is learned.
 */
export function initialTheta(c: Calibration, weight = 1.5, bias = -2.5) {
  return c.weights.flatMap((ws) => [...ws.map((x) => x * weight), bias]);
}
