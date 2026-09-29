// Which neurons the site draws, where, and what they do. Server and site both derive this
// from meta.bin, so the activity bitset needs no index list on the wire.
import type { NeuronMeta } from '../core/connectome';
import { buildGroups, groupsByName } from '../core/sensing';

/**
 * Parts of the nervous system, in the order the site colours them. Central neurons sit in the
 * brain and nerve cord; sensory neurons sit where they sense (eyes, head, body wall, wings).
 */
export const REGIONS = ['opticL', 'opticR', 'brain', 'neck', 'vnc', 'abdominal', 'motor', 'retinaL', 'retinaR', 'headSense', 'bodySense', 'wingL', 'wingR', 'gut'] as const;
export const REGION_QUOTA = [1500, 1500, 2600, 900, 3300, 700, 700, 800, 800, 600, 2200, 800, 800, 50];
const R = Object.fromEntries(REGIONS.map((name, i) => [name, i])) as Record<(typeof REGIONS)[number], number>;

/** What a displayed neuron does in this experiment. */
export const ROLE = { none: 0, input: 1, readout: 2 } as const;

const bySide = (side: number, index: number, left: number, right: number) => (side === 2 || (side === 0 && index & 1) ? right : left);

/** Nervous-system region for a neuron's superclass. */
export function regionOf(superclass: string, side: number, index: number) {
  if (superclass === 'ol_sensory') return bySide(side, index, R.retinaL, R.retinaR); // photoreceptors
  if (superclass.startsWith('ol_') || superclass.startsWith('visual_')) return bySide(side, index, R.opticL, R.opticR);
  if (superclass.startsWith('cb_sensory')) return R.headSense;
  if (superclass.startsWith('vnc_sensory') || superclass.startsWith('sensory_ascending')) {
    return index % 3 === 0 ? bySide(side, index, R.wingL, R.wingR) : R.bodySense; // wing sensilla vs. bristles and legs
  }
  if (superclass.startsWith('cb_')) return R.brain;
  if (superclass.includes('descending') || superclass.includes('ascending')) return R.neck;
  if (superclass === 'vnc_motor') return R.motor;
  if (superclass === 'ENS') return R.gut;
  if (superclass.startsWith('vnc_')) return index % 5 === 0 ? R.abdominal : R.vnc; // abdominal neuromeres sit at the back of the VNC
  return R.brain;
}

/**
 * Every game-input neuron (LC4, LPLC1, LPLC2) and every neuron an action is read from is always
 * drawn; the rest of each region is an even sample up to its quota. `readoutGroups` comes from the
 * server (it is measured at calibration), so both sides must pass the same list.
 */
export function pickDisplayNeurons(meta: NeuronMeta, readoutGroups: readonly string[] = []) {
  const g = buildGroups(meta), role = new Uint8Array(meta.n);
  for (const ids of [...g.lc4, ...g.lplc1, g.lplc2L, g.lplc2R]) for (const id of ids) role[id] = ROLE.input;
  for (const ids of groupsByName(meta, readoutGroups)) for (const id of ids) role[id] = ROLE.readout;

  const special: number[][] = REGIONS.map(() => []), rest: number[][] = REGIONS.map(() => []);
  for (let i = 0; i < meta.n; i++) (role[i] ? special : rest)[regionOf(meta.superclasses[meta.classIdx[i]], meta.side[i], i)].push(i);

  const ids: number[] = [], region: number[] = [], roles: number[] = [];
  REGIONS.forEach((_, r) => {
    for (const id of special[r]) { ids.push(id); region.push(r); roles.push(role[id]); }
    const cands = rest[r], q = Math.max(0, Math.min(REGION_QUOTA[r] - special[r].length, cands.length));
    for (let j = 0; j < q; j++) { ids.push(cands[Math.floor((j * cands.length) / q)]); region.push(r); roles.push(ROLE.none); }
  });
  return { ids: Int32Array.from(ids), region: Uint8Array.from(region), role: Uint8Array.from(roles) };
}
