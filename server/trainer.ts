// Evolution strategy over the readout parameters θ. One fee-paid attempt = one sample.
// Samples come in antithetic pairs (θ ± σε) run on the same course and noise seed,
// and θ moves along the rank-weighted noise once the whole generation has flown.

export interface TrainerState {
  theta: number[]; generation: number; sigma: number; lr: number; pop: number;
  noise: number[][]; seeds: number[]; fitness: (number | null)[];
}

export interface Sample { index: number; generation: number; theta: number[]; seed: number }

export function initialTrainer(theta: number[], opts: { pop?: number; sigma?: number; lr?: number } = {}): TrainerState {
  const pop = opts.pop ?? 10;
  if (pop < 2 || pop % 2) throw new Error('population must be an even number ≥ 2');
  return { theta: [...theta], generation: 0, sigma: opts.sigma ?? 0.5, lr: opts.lr ?? 0.5, pop, noise: [], seeds: [], fitness: Array(pop).fill(null) };
}


export class Trainer {
  private readonly issued = new Set<number>();

  constructor(readonly state: TrainerState, private readonly rand: () => number = Math.random) {}

  private gaussian() { let u = 0; while (!u) u = this.rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rand()); }

  /** Is there a sample of this generation that is neither reported nor already out? */
  canIssue() { return this.state.fitness.some((f, i) => f === null && !this.issued.has(i)); }

  /** A sample that was handed out but never ran (its worker failed): hand it out again later. */
  unissue(index: number) { this.issued.delete(index); }

  next(): Sample {
    const s = this.state;
    if (!s.noise.length) {
      for (let k = 0; k < s.pop / 2; k++) { s.noise.push(s.theta.map(() => this.gaussian())); s.seeds.push(Math.floor(this.rand() * 2 ** 32) >>> 0); }
    }
    const index = s.fitness.findIndex((f, i) => f === null && !this.issued.has(i));
    if (index < 0) throw new Error('every sample of this generation is already out');
    this.issued.add(index);
    const eps = s.noise[index >> 1], sign = index & 1 ? -1 : 1;
    return { index, generation: s.generation, theta: s.theta.map((x, d) => x + sign * s.sigma * eps[d]), seed: s.seeds[index >> 1] };
  }

  report(index: number, value: number) {
    const s = this.state;
    if (!(index >= 0 && index < s.pop) || s.fitness[index] !== null) throw new Error(`sample ${index} is not awaiting a result`);
    s.fitness[index] = value;
    if (s.fitness.some((f) => f === null)) return;
    // Compare the two halves of each pair only: they ran the same course, so how hard that course
    // was cancels out. Pairs are weighted by the rank of how much their halves differed, signed
    // toward the better half.
    const f = s.fitness as number[], K = s.pop / 2;
    const diff = Array.from({ length: K }, (_, k) => f[2 * k] - f[2 * k + 1]);
    const order = diff.map((_, k) => k).sort((a, b) => Math.abs(diff[a]) - Math.abs(diff[b])), w = Array(K).fill(0);
    order.forEach((k, rank) => (w[k] = Math.sign(diff[k]) * (rank + 1) / K));
    s.theta = s.theta.map((x, d) => {
      let g = 0; for (let k = 0; k < K; k++) g += w[k] * s.noise[k][d];
      return x + (s.lr / (s.pop * s.sigma)) * g;
    });
    s.generation++; s.noise = []; s.seeds = []; s.fitness = Array(s.pop).fill(null); this.issued.clear();
  }
}
