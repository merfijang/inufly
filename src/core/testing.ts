// Test helper: a tiny hand-built connectome with the neuron types the sensing code looks for.
import { Connectome, type NeuronMeta, type SparseWeights } from './connectome';

const TYPES = ['LC4', 'LPLC1', 'LPLC2', 'DNa02', 'DNg111', 'DNp01', 'DNa07'];

/** One neuron of every type per side, no synapses, no noise, no tonic drive. */
export function tinyBrain(seed = 1) {
  const typeIdx: number[] = [], side: number[] = [];
  for (const s of [1, 2]) TYPES.forEach((_, t) => { typeIdx.push(t); side.push(s); });
  const n = typeIdx.length;
  const meta: NeuronMeta = {
    n, types: TYPES, superclasses: ['descending_neuron'], params: { dt: 0.02, tau: 0.1, gain: 3, tonic: 0, noise_hz: 0, noise_amp: 0 },
    typeIdx: Uint16Array.from(typeIdx), classIdx: new Uint8Array(n), side: Uint8Array.from(side)
  };
  const weights: SparseWeights = { n, nnz: 0, colPtr: new Uint32Array(n + 1), rowIdx: new Uint32Array(0), code: new Uint8Array(0), lut: new Float32Array(256) };
  return new Connectome(meta, weights, seed);
}
