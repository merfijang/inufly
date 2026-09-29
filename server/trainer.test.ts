import { describe, expect, it } from 'vitest';
import { initialTrainer, Trainer } from './trainer';

const seeded = (s = 1) => () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;

describe('Trainer (antithetic ES)', () => {
  it('issues antithetic pairs that share a seed', () => {
    const t = new Trainer(initialTrainer([0, 0, 0], { pop: 4 }), seeded());
    const a = t.next(), b = t.next();
    expect(a.seed).toBe(b.seed);
    a.theta.forEach((x, i) => expect(x).toBeCloseTo(-b.theta[i]));
    expect(t.next().seed).not.toBe(a.seed);
  });

  it('moves θ toward the better half of a pair after a full generation', () => {
    const t = new Trainer(initialTrainer([0], { pop: 2, sigma: 0.5, lr: 0.5 }), seeded(3));
    const a = t.next(), b = t.next();
    t.report(a.index, 10); t.report(b.index, 0);
    expect(Math.sign(t.state.theta[0])).toBe(Math.sign(a.theta[0]));
    expect(t.state.generation).toBe(1);
  });

  it('ignores how hard a course was: only the difference within each pair counts', () => {
    const run = (offset: number) => {
      const t = new Trainer(initialTrainer([0, 0], { pop: 4 }), seeded(7));
      const s = [t.next(), t.next(), t.next(), t.next()];
      [3, 1, 2, 5].forEach((v, i) => t.report(s[i].index, v + (i < 2 ? offset : 0)));
      return t.state.theta;
    };
    expect(run(1000)).toEqual(run(0));
  });

  it('does not update until every sample of the generation is reported', () => {
    const t = new Trainer(initialTrainer([0, 0], { pop: 4 }), seeded());
    for (let i = 0; i < 3; i++) t.report(t.next().index, i);
    expect(t.state.generation).toBe(0);
    expect(t.state.theta).toEqual([0, 0]);
    t.report(t.next().index, 5);
    expect(t.state.generation).toBe(1);
  });

  it('resumes after a restart by re-issuing the unreported sample', () => {
    const t = new Trainer(initialTrainer([1, 2], { pop: 4 }), seeded());
    for (let i = 0; i < 3; i++) t.report(t.next().index, i);
    const lost = t.next(); // server dies before reporting this one
    const again = new Trainer(JSON.parse(JSON.stringify(t.state)), seeded(99)).next();
    expect(again).toEqual(lost);
  });

  it('rejects reports for unknown or already reported samples', () => {
    const t = new Trainer(initialTrainer([0], { pop: 2 }), seeded());
    const a = t.next();
    t.report(a.index, 1);
    expect(() => t.report(a.index, 2)).toThrow();
    expect(() => t.report(5, 2)).toThrow();
  });
});

