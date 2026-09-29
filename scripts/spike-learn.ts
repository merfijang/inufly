// Can the fly learn to run? Calibrate, then fly ES generations and print how far each gets.
import { loadBrain } from '../server/brainFiles';
import { buildGroups } from '../src/core/sensing';
import { calibrateReadout, initialTheta } from '../src/core/calibrate';
import { NeuralPolicy, paramCount } from '../src/core/policy';
import { RunnerGame } from '../src/game/runner';
import { initialTrainer, Trainer } from '../server/trainer';

const GENS = Number(process.argv[2] ?? 6), CAP = Number(process.argv[3] ?? 60);
const t0 = performance.now();
const brain = loadBrain('brain'), groups = buildGroups(brain.meta);
console.log(`loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
const t1 = performance.now();
const cal = calibrateReadout(brain, groups, brain.meta);
console.log(`calibrated in ${((performance.now() - t1) / 1000).toFixed(1)} s`);
['left', 'right', 'jump'].forEach((a, h) => console.log(a, cal.readout.heads[h].map((k, j) => `${cal.readout.names[k]}(${cal.weights[h][j].toFixed(2)})`).join(' ')));
const policy = new NeuralPolicy(brain, groups, cal.readout);

function run(theta: number[], seed: number) {
  const g = new RunnerGame(seed); policy.begin(theta, seed);
  const acts = { left: 0, right: 0, jump: 0 };
  while (g.state.alive && g.state.t < CAP) { const d = policy.tick(g, g.state.t * 1000); if (d.action) acts[d.action]++; g.update(0.02); }
  return { z: g.state.z, cause: g.state.cause, acts };
}
const zero = new Array(paramCount(cal.readout)).fill(0).map((_, i, a) => 0);
for (const [name, th] of [['init', initialTheta(cal)], ["quiet", initialTheta(cal, 0, -5)]] as const) {
  const r = [11, 22, 33].map((s) => run(th as number[], s));
  console.log(name, r.map((x) => `${x.z.toFixed(0)}m ${x.cause} L${x.acts.left} R${x.acts.right} J${x.acts.jump}`).join(' | '));
}
const tr = new Trainer(initialTrainer(initialTheta(cal)));
let steps = 0; const ts = performance.now();
for (let gen = 0; gen < GENS; gen++) {
  const fits: number[] = [];
  for (let i = 0; i < tr.state.pop; i++) { const s = tr.next(); const r = run(s.theta, s.seed); steps += r.z; fits.push(r.z); tr.report(s.index, r.z); }
  const cur = [101, 202, 303].map((s) => run(tr.state.theta, s).z);
  console.log(`gen ${gen}: samples mean ${(fits.reduce((a, b) => a + b) / fits.length).toFixed(0)} max ${Math.max(...fits).toFixed(0)} | theta on fresh courses ${cur.map((z) => z.toFixed(0)).join(', ')} | ${((performance.now() - ts) / 1000).toFixed(0)} s`);
}
