import { describe, expect, it } from 'vitest';
import { CourseGen, DEFAULT_COURSE, distanceAt, RAMP_LEN, RunnerGame, TRAIN_HEIGHT, timeAt, zAt, type Obstacle } from './runner';

/** A game whose course is exactly `obstacles`. */
function gameWith(obstacles: Obstacle[]) {
  const g = new RunnerGame(1);
  g.gen.obstacles.splice(0, g.gen.obstacles.length, ...obstacles);
  (g.gen as unknown as { nextZ: number }).nextZ = Infinity;
  return g;
}
const runUntil = (g: RunnerGame, z: number) => { while (g.state.alive && g.state.z < z) g.update(0.02); };
/** Run until `seconds` before reaching z. */
const runTo = (g: RunnerGame, z: number, seconds: number) => { while (g.state.alive && timeAt(g.course, z) - g.state.t > seconds) g.update(0.02); };

describe('course', () => {
  it('is the same for the same seed and differs between seeds', () => {
    const a = new CourseGen(7), b = new CourseGen(7), c = new CourseGen(8);
    [a, b, c].forEach((g) => g.ensure(3000));
    expect(a.obstacles).toEqual(b.obstacles);
    expect(a.obstacles).not.toEqual(c.obstacles);
  });

  it('never blocks all three lanes with trains without a ramp to run over them', () => {
    const g = new CourseGen(3); g.ensure(30000);
    for (let z = 0; z < 30000; z += 1) {
      const t = timeAt(g.course, z);
      const walls = g.obstacles.filter((o) => (o.kind === 'train' || o.kind === 'moving') && zAt(o, t) <= z && zAt(o, t) + o.len >= z);
      const ramped = new Set(g.obstacles.filter((o) => o.kind === 'ramp').map((o) => `${o.lane}:${o.z + o.len}`));
      expect(walls.filter((o) => !ramped.has(`${o.lane}:${o.z}`)).length).toBeLessThan(3);
    }
  });

  it('brings obstacles often: a row every second or so', () => {
    const g = new CourseGen(5); g.ensure(distanceAt(g.course, 60));
    const rows = new Set(g.obstacles.map((o) => Math.round(o.z)));
    expect(rows.size).toBeGreaterThan(40);
  });

  it('puts every Subway Surfers obstacle on the track', () => {
    const g = new CourseGen(9); g.ensure(20000);
    expect(new Set(g.obstacles.map((o) => o.kind))).toEqual(new Set(['low', 'roadblock', 'high', 'train', 'moving', 'ramp']));
  });
});

describe('RunnerGame', () => {
  it('keeps speeding up', () => {
    const g = gameWith([]);
    runUntil(g, 3000);
    expect(g.state.speed).toBeGreaterThan(DEFAULT_COURSE.startSpeed * 1.8);
  });

  it('dies on a train in its lane, and dodges it by changing lanes', () => {
    const hit = gameWith([{ lane: 0, z: 30, len: 10, kind: 'train' }]);
    runUntil(hit, 100);
    expect(hit.state.cause).toBe('Ran into a train.');
    const dodge = gameWith([{ lane: 0, z: 30, len: 10, kind: 'train' }]);
    runUntil(dodge, 20); dodge.act('left');
    runUntil(dodge, 100);
    expect(dodge.state).toMatchObject({ alive: true, lane: -1, x: -1 });
  });

  it('jumps a low barrier, rolls under a high one, and does either at a roadblock', () => {
    const jumpLow = gameWith([{ lane: 0, z: 40, len: 0.4, kind: 'low' }]);
    runTo(jumpLow, 40, 0.35); jumpLow.act('jump'); runUntil(jumpLow, 80);
    expect(jumpLow.state.alive).toBe(true);
    const rollLow = gameWith([{ lane: 0, z: 40, len: 0.4, kind: 'low' }]);
    runTo(rollLow, 40, 0.3); rollLow.act('roll'); runUntil(rollLow, 80);
    expect(rollLow.state.cause).toBe('Tripped over a low barrier.');

    const rollHigh = gameWith([{ lane: 0, z: 40, len: 0.4, kind: 'high' }]);
    runTo(rollHigh, 40, 0.3); rollHigh.act('roll'); runUntil(rollHigh, 80);
    expect(rollHigh.state.alive).toBe(true);
    const jumpHigh = gameWith([{ lane: 0, z: 40, len: 0.4, kind: 'high' }]);
    runTo(jumpHigh, 40, 0.35); jumpHigh.act('jump'); runUntil(jumpHigh, 80);
    expect(jumpHigh.state.cause).toBe('Ran into a high barrier.');

    for (const move of ['jump', 'roll'] as const) {
      const g = gameWith([{ lane: 0, z: 40, len: 0.4, kind: 'roadblock' }]);
      runTo(g, 40, move === 'jump' ? 0.35 : 0.3); g.act(move); runUntil(g, 80);
      expect(g.state.alive).toBe(true);
    }
    const stand = gameWith([{ lane: 0, z: 40, len: 0.4, kind: 'roadblock' }]);
    runUntil(stand, 80);
    expect(stand.state.cause).toBe('Hit a roadblock.');
  });

  it('runs up a ramp onto the roof of a train and drops off the end', () => {
    const g = gameWith([{ lane: 0, z: 30, len: RAMP_LEN, kind: 'ramp' }, { lane: 0, z: 30 + RAMP_LEN, len: 20, kind: 'train' }]);
    runUntil(g, 30 + RAMP_LEN + 5);
    expect(g.state.alive).toBe(true);
    expect(g.state.y).toBeCloseTo(TRAIN_HEIGHT);
    runUntil(g, 100);
    expect(g.state).toMatchObject({ alive: true, y: 0 });
  });

  it('cannot jump onto a train without a ramp', () => {
    const g = gameWith([{ lane: 0, z: 40, len: 20, kind: 'train' }]);
    runTo(g, 40, 0.35); g.act('jump'); runUntil(g, 100);
    expect(g.state.cause).toBe('Ran into a train.');
  });

  it('meets a moving train where the course says, coming toward the dog', () => {
    const meet = timeAt(DEFAULT_COURSE, 60), o: Obstacle = { lane: 0, z: 60, len: 12, kind: 'moving', v: 9, meet };
    expect(zAt(o, 0)).toBeGreaterThan(60);
    expect(zAt(o, meet)).toBeCloseTo(60);
    const g = gameWith([o]);
    runUntil(g, 200);
    expect(g.state.cause).toBe('Hit by an oncoming train.');
    expect(g.state.z).toBeLessThan(61);
  });

  it('ignores a turn off the edge, a second turn mid-switch and a jump in the air', () => {
    const g = gameWith([]);
    expect(g.act('left')).toBe(true);
    expect(g.act('left')).toBe(false); // still switching
    runUntil(g, 10);
    expect(g.act('left')).toBe(false); // edge of the track
    expect(g.act('jump')).toBe(true);
    g.update(0.02);
    expect(g.act('jump')).toBe(false);
    expect(g.act('roll')).toBe(true); // a roll in the air slams the dog down
    expect(g.state.vy).toBeLessThan(0);
  });
});
