// Game → the fly's visual neurons, and neurons → readout features.
// One game quantity per visual population, on the side where it is: mixed into one population
// the quantities are not readable further in (learned in FlappyFly, scripts/spike-encoder.ts there).
import type { RunnerGame } from '../game/runner';
import { cellsOf, type Connectome, type NeuronMeta } from './connectome';

/** How hard the game drives the visual neurons (FlappyFly measured 3 as the readable middle). */
export const STIMULUS_GAIN = 3;

/** How much of the previous readout value is kept each 20 ms step. */
export const TRACE_KEEP = 0.5;

/** Group sizes below this spike too erratically to read from. */
export const MIN_GROUP_CELLS = 5;

/** How far ahead the fly sees, in seconds to contact. */
export const HORIZON_SECONDS = 1.5;

export interface SensoryGroups { lc4: Int32Array[]; lplc1: Int32Array[]; lplc2L: Int32Array; lplc2R: Int32Array }

export function buildGroups(meta: NeuronMeta): SensoryGroups {
  const both = (name: string) => [cellsOf(meta, name, 'L'), cellsOf(meta, name, 'R')];
  return { lc4: both('LC4'), lplc1: both('LPLC1'), lplc2L: cellsOf(meta, 'LPLC2', 'L'), lplc2R: cellsOf(meta, 'LPLC2', 'R') };
}

/** What the dog is up against, each 0 (nothing) … 1 (right there). */
export interface Senses {
  /** something low in its own lane: jump */ barrier: number;
  /** a train in its own lane: change lanes */ train: number;
  /** the lane to the left is blocked by a train or the edge of the track */ leftBlocked: number;
  rightBlocked: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function readSenses(game: RunnerGame, horizon = HORIZON_SECONDS): Senses {
  const s = game.state, reach = s.speed * horizon;
  const near = (lane: number, kinds: string[], behind = 0) => {
    let best = 0;
    for (const o of game.gen.between(s.z - behind, s.z + reach)) {
      if (o.lane !== lane || !kinds.includes(o.kind)) continue;
      best = Math.max(best, o.z <= s.z ? 1 : 1 - (o.z - s.z) / reach);
    }
    return clamp01(best);
  };
  const side = (lane: number) => (lane < -1 || lane > 1 ? 1 : near(lane, ['train'], 1));
  return {
    barrier: near(s.lane, ['barrier', 'wall']),
    train: near(s.lane, ['train']),
    leftBlocked: side(s.lane - 1),
    rightBlocked: side(s.lane + 1)
  };
}

/**
 * Inject what the dog is up against into the fly's visual populations: low obstacles ahead on the
 * looming cells (LC4, the giant-fibre escape input), trains ahead on LPLC1 (small approaching
 * objects), and which side is blocked on LPLC2 of that side.
 */
export function sense(brain: Connectome, g: SensoryGroups, x: Senses, gain = STIMULUS_GAIN) {
  for (const ids of g.lc4) brain.stimulate(ids, x.barrier * gain);
  for (const ids of g.lplc1) brain.stimulate(ids, x.train * gain);
  brain.stimulate(g.lplc2L, x.leftBlocked * gain);
  brain.stimulate(g.lplc2R, x.rightBlocked * gain);
}

/** The populations we drive ourselves: reading them back would be reading our own signal. */
export const STIMULATED_TYPES = new Set(['LC4', 'LPLC1', 'LPLC2']);

/** Every cell type in the brain, split by side, except the ones the game drives. */
export function readableGroups(meta: NeuronMeta, minCells = MIN_GROUP_CELLS) {
  const byName = new Map<string, number[]>();
  for (let i = 0; i < meta.n; i++) {
    const type = meta.types[meta.typeIdx[i]];
    if (STIMULATED_TYPES.has(type)) continue;
    const name = `${type} ${meta.side[i] === 2 ? 'R' : 'L'}`;
    (byName.get(name) ?? byName.set(name, []).get(name)!).push(i);
  }
  const names = [...byName.keys()].filter((n) => byName.get(n)!.length >= minCells).sort();
  return { names, ids: names.map((n) => Int32Array.from(byName.get(n)!)) };
}

/** Cells of the named groups, in the given order (missing names give empty groups). */
export function groupsByName(meta: NeuronMeta, names: readonly string[]) {
  const all = readableGroups(meta, 1), index = new Map(all.names.map((n, i) => [n, i]));
  return names.map((n) => (index.has(n) ? all.ids[index.get(n)!] : new Int32Array()));
}

export function readRates(brain: Connectome, ids: Int32Array[], out: Float32Array) {
  for (let i = 0; i < ids.length; i++) {
    const group = ids[i];
    let hits = 0;
    for (let k = 0; k < group.length; k++) hits += brain.spiked[group[k]];
    out[i] = group.length ? hits / group.length : 0;
  }
  return out;
}
