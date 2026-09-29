import { describe, expect, it } from 'vitest';
import { RunnerGame, type Obstacle } from '../game/runner';
import { LANE_COOLDOWN_MS, NeuralPolicy, paramCount, type Readout } from './policy';
import { buildGroups, readSenses } from './sensing';
import { tinyBrain } from './testing';

const readout: Readout = { names: ['DNp01 L', 'DNa02 L', 'DNa02 R', 'DNa07 L'], mean: [0, 0, 0, 0], std: [1, 1, 1, 1], heads: [[1], [2], [0], [3]] };
/** θ for heads left, right, jump, roll: one weight each plus a bias */
const theta = (left: number, right: number, jump: number, roll = -20) => [0, left, 0, right, 0, jump, 0, roll];

describe('NeuralPolicy', () => {
  it('has one weight per group each action reads, plus a bias per action', () => expect(paramCount(readout)).toBe(8));

  it('does nothing when every bias says no', () => {
    const brain = tinyBrain(), g = new RunnerGame(1), policy = new NeuralPolicy(brain, buildGroups(brain.meta), readout);
    policy.begin(theta(-20, -20, -20), 1);
    for (let t = 0; t < 50; t++) expect(policy.tick(g, t * 20).action).toBeNull();
  });

  it('acts on the most likely action, and spaces lane changes out', () => {
    const brain = tinyBrain(), g = new RunnerGame(1), policy = new NeuralPolicy(brain, buildGroups(brain.meta), readout);
    policy.begin(theta(5, -20, -20), 1);
    const moves: number[] = [];
    for (let t = 0; t < 50; t++) { if (policy.tick(g, t * 20).action === 'left') moves.push(t * 20); g.update(0.02); }
    expect(moves[0]).toBe(0);
    expect(moves.length).toBe(1); // only one lane to the left of the middle
    policy.begin(theta(-20, 5, -20), 1);
    const g2 = new RunnerGame(1), right: number[] = [];
    for (let t = 0; t < 50; t++) { if (policy.tick(g2, t * 20).action === 'right') right.push(t * 20); g2.update(0.02); }
    expect(right).toHaveLength(1);
    expect(LANE_COOLDOWN_MS).toBeGreaterThan(0);
  });

  it('rejects θ of the wrong length', () => {
    const brain = tinyBrain(), policy = new NeuralPolicy(brain, buildGroups(brain.meta), readout);
    expect(() => policy.begin([0, 0], 1)).toThrow();
  });
});

describe('senses', () => {
  it('sees a train ahead in its lane, and the edge of the track as blocked', () => {
    const g = new RunnerGame(1);
    g.gen.obstacles.splice(0, g.gen.obstacles.length, { lane: 0, z: 10, len: 10, kind: 'train' }, { lane: 1, z: 12, len: 0.4, kind: 'high' });
    g.state.lane = -1; g.state.x = -1;
    expect(readSenses(g)).toMatchObject({ jump: 0, roll: 0, train: 0, leftBlocked: 1 });
    expect(readSenses(g).rightBlocked).toBeGreaterThan(0.3);
    g.state.lane = 0; g.state.x = 0;
    expect(readSenses(g).train).toBeGreaterThan(0.3);
  });
});

describe('senses: what to do about the nearest thing ahead', () => {
  const at = (o: Obstacle) => {
    const g = new RunnerGame(1);
    g.gen.obstacles.splice(0, g.gen.obstacles.length, o);
    return readSenses(g);
  };
  it('says jump for a low barrier, roll for a high one, both for a roadblock', () => {
    expect(at({ lane: 0, z: 10, len: 0.4, kind: 'low' })).toMatchObject({ roll: 0, train: 0 });
    expect(at({ lane: 0, z: 10, len: 0.4, kind: 'low' }).jump).toBeGreaterThan(0.3);
    expect(at({ lane: 0, z: 10, len: 0.4, kind: 'high' })).toMatchObject({ jump: 0, train: 0 });
    expect(at({ lane: 0, z: 10, len: 0.4, kind: 'high' }).roll).toBeGreaterThan(0.3);
    const rb = at({ lane: 0, z: 10, len: 0.4, kind: 'roadblock' });
    expect(rb.jump).toBeGreaterThan(0.3); expect(rb.roll).toBe(rb.jump);
  });
  it('sees an oncoming train sooner than a parked one at the same spot', () => {
    const parked = at({ lane: 0, z: 25, len: 10, kind: 'train' }).train;
    const moving = at({ lane: 0, z: 25, len: 10, kind: 'moving', v: 9, meet: 1 }).train;
    expect(moving).toBeGreaterThan(parked);
  });
  it('treats a ramp as the way up, not something to dodge', () => {
    expect(at({ lane: 0, z: 10, len: 8, kind: 'ramp' })).toMatchObject({ jump: 0, roll: 0, train: 0 });
  });
});
