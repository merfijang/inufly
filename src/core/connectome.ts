// Pure MaleCNS connectome simulation, extracted from brain/flyBrain.worker.ts so it
// can run outside the browser. No DOM, Worker or fetch: callers pass byte buffers.

export interface SimParams { dt: number; tau: number; gain: number; tonic: number; noise_hz: number; noise_amp: number }

export interface NeuronMeta {
  n: number; types: string[]; superclasses: string[]; params: SimParams;
  typeIdx: Uint16Array; classIdx: Uint8Array; side: Uint8Array; // side: 0 = none, 1 = L, 2 = R
}

export interface SparseWeights { n: number; nnz: number; colPtr: Uint32Array; rowIdx: Uint32Array; code: Uint8Array; lut: Float32Array }

function magic(view: DataView, want: string) {
  const got = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (got !== want) throw new Error(`Expected ${want}, got ${got}`);
}

export function parseMeta(buf: ArrayBuffer): NeuronMeta {
  const view = new DataView(buf); magic(view, 'FLYM');
  const n = view.getUint32(8, true), len = view.getUint32(12, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 16, len)));
  let at = 16 + len;
  const typeIdx = new Uint16Array(buf.slice(at, at + 2 * n)); at += 2 * n;
  const classIdx = new Uint8Array(buf, at, n); at += n;
  return { n, types: head.types, superclasses: head.superclasses, params: head.params, typeIdx, classIdx, side: new Uint8Array(buf, at, n) };
}

export function parseWeights(buf: ArrayBuffer): SparseWeights {
  const view = new DataView(buf); magic(view, 'FLYW');
  const n = view.getUint32(8, true), nnz = view.getUint32(12, true), lnMin = view.getFloat32(16, true), bytes = new Uint8Array(buf);
  let at = 20;
  const varint = () => { let x = 0, shift = 0, b = 0; do { b = bytes[at++]; x += (b & 127) * 2 ** shift; shift += 7; } while (b & 128); return x; };
  const colPtr = new Uint32Array(n + 1);
  for (let j = 0; j < n; j++) colPtr[j + 1] = colPtr[j] + varint();
  const rowIdx = new Uint32Array(nnz);
  for (let j = 0; j < n; j++) {
    let row = 0;
    for (let e = colPtr[j], first = true; e < colPtr[j + 1]; e++, first = false) { row = first ? varint() : row + varint(); rowIdx[e] = row; }
  }
  const code = bytes.slice(at, at + nnz), lut = new Float32Array(256);
  for (let q = 0; q < 128; q++) { const mag = Math.exp(lnMin * (1 - q / 127)); lut[q] = mag; lut[q | 128] = -mag; }
  return { n, nnz, colPtr, rowIdx, code, lut };
}

/** Neurons whose cell type or superclass equals `name`, optionally on one side. */
export function cellsOf(meta: NeuronMeta, name: string, side?: 'L' | 'R') {
  const byType = meta.types.map((t) => t === name), byClass = meta.superclasses.map((t) => t === name);
  const s = side === 'L' ? 1 : side === 'R' ? 2 : 0, out: number[] = [];
  for (let i = 0; i < meta.n; i++) if ((byType[meta.typeIdx[i]] || byClass[meta.classIdx[i]]) && (!s || meta.side[i] === s)) out.push(i);
  return Int32Array.from(out);
}

/** Leaky integrate-and-fire network with the same dynamics as the browser worker. */
export class Connectome {
  readonly n: number;
  readonly v: Float32Array; readonly spiked: Uint8Array;
  private readonly drive: Float32Array; private readonly current: Float32Array; private readonly fired: Int32Array;
  firedCount = 0; totalSpikes = 0; private rng = 1;

  constructor(readonly meta: NeuronMeta, private readonly w: SparseWeights, seed = 1) {
    if (meta.n !== w.n) throw new Error(`meta has ${meta.n} neurons, weights have ${w.n}`);
    this.n = meta.n;
    this.v = new Float32Array(this.n); this.spiked = new Uint8Array(this.n);
    this.drive = new Float32Array(this.n); this.current = new Float32Array(this.n); this.fired = new Int32Array(this.n);
    this.reset(seed);
  }

  reset(seed: number) {
    this.v.fill(0); this.drive.fill(0); this.current.fill(0); this.spiked.fill(0);
    this.firedCount = 0; this.totalSpikes = 0; this.rng = seed >>> 0;
  }

  random() { this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0; return this.rng / 4294967296; }

  stimulate(ids: Int32Array | undefined, amount: number) { if (ids) for (let k = 0; k < ids.length; k++) this.drive[ids[k]] += amount; }

  /** Advance one dt. Returns the neurons that fired this step (a view, valid until the next step). */
  step(): Int32Array {
    const { colPtr, rowIdx, code, lut } = this.w, current = this.current, fired = this.fired;
    current.fill(0);
    for (let k = 0; k < this.firedCount; k++) { const j = fired[k]; for (let e = colPtr[j]; e < colPtr[j + 1]; e++) current[rowIdx[e]] += lut[code[e]]; }
    const p = this.meta.params, decay = Math.exp(-p.dt / p.tau), pNoise = p.noise_hz * p.dt;
    let count = 0;
    for (let i = 0; i < this.n; i++) {
      let x = decay * this.v[i] + p.gain * current[i] + p.tonic + this.drive[i];
      if (this.random() < pNoise) x += p.noise_amp;
      if (x >= 1) { fired[count++] = i; this.spiked[i] = 1; x = 0; } else this.spiked[i] = 0;
      this.v[i] = x; this.drive[i] = 0;
    }
    this.firedCount = count; this.totalSpikes += count;
    return fired.subarray(0, count);
  }

  /** Neurons that fired in the most recent step. */
  lastFired(): Int32Array { return this.fired.subarray(0, this.firedCount); }

  /** Fraction of a group that fired this step, saturating at 30% (same scale as the worker). */
  rate(ids: Int32Array | undefined) {
    if (!ids) return 0;
    let hits = 0; for (let k = 0; k < ids.length; k++) hits += this.spiked[ids[k]];
    return Math.min(1, hits / Math.max(1, ids.length * 0.3));
  }
}
