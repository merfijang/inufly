import { describe, expect, it } from 'vitest';
import { CourseGen, JUMP_SECONDS, RunnerGame, type Obstacle } from './runner';

/** A game whose course is exactly `obstacles`. */
function gameWith(obstacles: Obstacle[]) {
  const g = new RunnerGame(1);
  g.gen.obstacles.splice(0, g.gen.obstacles.length, ...obstacles);
  (g.gen as unknown as { nextZ: number }).nextZ = Infinity;
  return g;
}
const runUntil = (g: RunnerGame, z: number, each?: (g: RunnerGame) => void) => { while (g.state.alive && g.state.z < z) { each?.(g); g.update(0.02); } };

describe('course', () => {
  it('is the same for the same seed and differs between seeds', () => {
    const a = new CourseGen(7), b = new CourseGen(7), c = new CourseGen(8);
    [a, b, c].forEach((g) => g.ensure(2000));
    expect(a.obstacles).toEqual(b.obstacles);
    expect(a.obstacles).not.toEqual(c.obstacles);
  });

  it('never blocks all three lanes with trains at once', () => {
    const g = new CourseGen(3); g.ensure(20000);
    const trains = g.obstacles.filter((o) => o.kind === 'train');
    for (let z = 0; z < 20000; z += 1) expect(trains.filter((o) => o.z <= z && o.z + o.len >= z).length).toBeLessThan(3);
  });
});

describe('RunnerGame', () => {
  it('runs forward, speeds up, and dies on a train in its lane', () => {
    const g = gameWith([{ lane: 0, z: 30, len: 10, kind: 'train' }]);
    runUntil(g, 100);
    expect(g.state.alive).toBe(false);
    expect(g.state.cause).toBe('Ran into a train.');
    expect(g.state.z).toBeGreaterThan(29);
    expect(g.state.speed).toBeGreaterThan(10);
  });

  it('dodges a train by changing lanes', () => {
    const g = gameWith([{ lane: 0, z: 30, len: 10, kind: 'train' }]);
    runUntil(g, 20); g.act('left');
    runUntil(g, 100);
    expect(g.state).toMatchObject({ alive: true, lane: -1, x: -1 });
  });

  it('clears a barrier with a well-timed jump, and trips without one', () => {
    const miss = gameWith([{ lane: 0, z: 30, len: 0.5, kind: 'barrier' }]);
    runUntil(miss, 100);
    expect(miss.state.cause).toBe('Tripped over a barrier.');
    const hop = gameWith([{ lane: 0, z: 30, len: 0.5, kind: 'barrier' }]);
    runUntil(hop, 30 - (JUMP_SECONDS / 2) * 10); hop.act('jump');
    runUntil(hop, 100);
    expect(hop.state.alive).toBe(true);
  });

  it('ignores a turn off the edge, a second turn mid-switch and a jump in the air', () => {
    const g = gameWith([]);
    expect(g.act('left')).toBe(true);
    expect(g.act('left')).toBe(false); // still switching
    runUntil(g, 5);
    expect(g.act('left')).toBe(false); // edge of the track
    expect(g.act('jump')).toBe(true);
    expect(g.act('jump')).toBe(false);
  });
});
