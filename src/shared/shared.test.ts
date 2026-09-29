import { describe, expect, it } from 'vitest';
import type { NeuronMeta } from '../core/connectome';
import { pickDisplayNeurons, REGION_QUOTA, REGIONS, regionOf, ROLE } from './display';
import { decodeBits, encodeBits } from './protocol';

describe('activity bitset', () => {
  it('round-trips counts that are not a multiple of 8', () => {
    const hits = Uint8Array.from({ length: 13 }, (_, i) => (i % 3 === 0 ? 1 : 0));
    const bytes = encodeBits(hits);
    expect(bytes.length).toBe(2);
    expect(decodeBits(bytes, 13)).toEqual(hits);
  });
});

describe('display neurons', () => {
  const classes = ['ol_intrinsic', 'cb_intrinsic', 'descending_neuron', 'vnc_intrinsic', 'vnc_motor', 'ENS', 'visual_projection'];
  const types = ['other', 'LC4', 'LPLC1', 'DNp01'];
  const n = 60000;
  // every 1000th neuron is a visual input cell, every 1500th a readout DN
  const typeIdx = Uint16Array.from({ length: n }, (_, i) => (i % 1000 === 7 ? (i % 2 ? 1 : 2) : i % 1500 === 11 ? 3 : 0));
  const classIdx = Uint8Array.from({ length: n }, (_, i) => (typeIdx[i] === 1 || typeIdx[i] === 2 ? 6 : typeIdx[i] === 3 ? 2 : i % 6));
  const meta: NeuronMeta = { n, types, superclasses: classes, params: { dt: 0.02, tau: 0.1, gain: 3, tonic: 0, noise_hz: 0, noise_amp: 0 }, typeIdx, classIdx, side: Uint8Array.from({ length: n }, (_, i) => 1 + (i % 2)) };

  it('maps superclasses to nervous-system regions', () => {
    expect(REGIONS[regionOf('ol_intrinsic', 1, 1)]).toBe('opticL');
    expect(REGIONS[regionOf('visual_projection', 2, 1)]).toBe('opticR');
    expect(REGIONS[regionOf('cb_intrinsic', 1, 1)]).toBe('brain');
    expect(REGIONS[regionOf('ascending_neuron', 1, 1)]).toBe('neck');
    expect(REGIONS[regionOf('vnc_motor', 1, 1)]).toBe('motor');
    expect(REGIONS[regionOf('ENS', 0, 1)]).toBe('gut');
    expect(REGIONS[regionOf('vnc_intrinsic', 1, 1)]).toBe('vnc');
    expect(REGIONS[regionOf('ol_sensory', 2, 1)]).toBe('retinaR');
    expect(REGIONS[regionOf('cb_sensory', 1, 1)]).toBe('headSense');
    expect(REGIONS[regionOf('vnc_sensory', 1, 3)]).toBe('wingL');
    expect(REGIONS[regionOf('vnc_sensory', 1, 4)]).toBe('bodySense');
    expect(REGIONS[regionOf('sensory_ascending', 2, 4)]).toBe('bodySense');
  });

  it('always draws every game-input and readout neuron, with its role', () => {
    const d = pickDisplayNeurons(meta, ['DNp01 L', 'DNp01 R']), shown = new Map(Array.from(d.ids, (id, k) => [id, d.role[k]]));
    for (let i = 0; i < n; i++) {
      if (typeIdx[i] === 1 || typeIdx[i] === 2) expect(shown.get(i)).toBe(ROLE.input);
      if (typeIdx[i] === 3) expect(shown.get(i)).toBe(ROLE.readout);
    }
  });

  it('samples deterministically, within quotas, without duplicates', () => {
    const a = pickDisplayNeurons(meta, ['DNp01 L']), b = pickDisplayNeurons(meta, ['DNp01 L']);
    expect(a.ids).toEqual(b.ids);
    expect(new Set(a.ids).size).toBe(a.ids.length);
    REGIONS.forEach((_, r) => expect(a.region.filter((x) => x === r).length).toBeLessThanOrEqual(REGION_QUOTA[r]));
    a.ids.forEach((id, k) => expect(regionOf(classes[classIdx[id]], meta.side[id], id)).toBe(a.region[k]));
  });
});
