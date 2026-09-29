// A stripped-down Subway Surfers: three lanes, the dog runs on its own, obstacles come at it.
// Pure and seeded: the server runs it for real, and the site rebuilds the same course from the
// seed so only the dog's position has to travel over the wire.

/** Lanes are -1 (left), 0, 1 (right). Distances are metres along the track. */
export type ObstacleKind = 'barrier' | 'train' | 'wall';

export interface Obstacle { lane: number; z: number; len: number; kind: ObstacleKind }

export interface Course { startSpeed: number; maxSpeed: number; accel: number; firstAt: number; gapMin: number; gapMax: number }

export const DEFAULT_COURSE: Course = { startSpeed: 10, maxSpeed: 18, accel: 0.08, firstAt: 45, gapMin: 22, gapMax: 34 };

/** Barriers and walls are low: a jump clears them. Trains are not. */
export const HEIGHT: Record<ObstacleKind, number> = { barrier: 0.8, wall: 0.8, train: 3.2 };
export const JUMP_SECONDS = 0.8;
export const JUMP_HEIGHT = 1.6;
export const SWITCH_SECONDS = 0.2;
/** Half the dog's length and width, in metres and lanes. */
const DOG_HALF_LEN = 0.45, HIT_HALF_WIDTH = 0.5;

export type Action = 'left' | 'right' | 'jump';

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The obstacles of one course, generated row by row as the dog gets closer. Every row leaves at
 * least one lane free of trains, so every course can be run forever in principle.
 */
export class CourseGen {
  readonly obstacles: Obstacle[] = [];
  private readonly rand: () => number;
  private nextZ: number;

  constructor(readonly seed: number, readonly course: Course = DEFAULT_COURSE) {
    this.rand = mulberry(seed);
    this.nextZ = course.firstAt;
  }

  /** Make sure every row starting before `z` exists. */
  ensure(z: number) {
    while (this.nextZ < z) this.row();
  }

  private row() {
    const r = this.rand, z = this.nextZ, c = this.course;
    const pick = r();
    if (pick < 0.34) {
      this.obstacles.push({ lane: Math.floor(r() * 3) - 1, z, len: 0.5, kind: 'barrier' });
    } else if (pick < 0.46) {
      for (const lane of [-1, 0, 1]) this.obstacles.push({ lane, z, len: 0.5, kind: 'wall' });
    } else {
      // one or two trains; the free lane is chosen first so a row is never fully blocked
      const free = Math.floor(r() * 3) - 1, len = 10 + Math.floor(r() * 10);
      const blocked = [-1, 0, 1].filter((l) => l !== free);
      const lanes = r() < 0.45 ? blocked : [blocked[Math.floor(r() * 2)]];
      for (const lane of lanes) this.obstacles.push({ lane, z, len, kind: 'train' });
      this.nextZ = z + len;
    }
    this.nextZ = Math.max(this.nextZ, z) + c.gapMin + r() * (c.gapMax - c.gapMin);
  }

  /** Obstacles overlapping [from, to] along the track. */
  between(from: number, to: number) {
    return this.obstacles.filter((o) => o.z + o.len >= from && o.z <= to);
  }
}

export interface RunnerState {
  /** seconds since the start */ t: number;
  /** distance run, metres */ z: number;
  speed: number;
  /** lateral position in lanes (-1..1), moving toward `lane` while switching */ x: number;
  lane: number;
  /** height above the track, metres */ y: number;
  airLeft: number;
  alive: boolean;
  cause: string | null;
}

export class RunnerGame {
  readonly gen: CourseGen;
  state: RunnerState;

  constructor(seed: number, readonly course: Course = DEFAULT_COURSE) {
    this.gen = new CourseGen(seed, course);
    this.state = { t: 0, z: 0, speed: course.startSpeed, x: 0, lane: 0, y: 0, airLeft: 0, alive: true, cause: null };
    this.gen.ensure(120);
  }

  get switching() { return Math.abs(this.state.x - this.state.lane) > 1e-6; }
  get airborne() { return this.state.airLeft > 0; }

  /** Apply one action; returns whether it did anything (a jump in the air or a turn off the edge does not). */
  act(a: Action) {
    const s = this.state;
    if (!s.alive) return false;
    if (a === 'jump') { if (this.airborne) return false; s.airLeft = JUMP_SECONDS; return true; }
    if (this.switching) return false;
    const lane = s.lane + (a === 'left' ? -1 : 1);
    if (lane < -1 || lane > 1) return false;
    s.lane = lane;
    return true;
  }

  update(dt: number) {
    const s = this.state, c = this.course;
    if (!s.alive) return;
    s.t += dt;
    s.speed = Math.min(c.maxSpeed, c.startSpeed + c.accel * s.t);
    s.z += s.speed * dt;
    const step = dt / SWITCH_SECONDS;
    s.x = s.x < s.lane ? Math.min(s.lane, s.x + step) : Math.max(s.lane, s.x - step);
    if (s.airLeft > 0) {
      s.airLeft = Math.max(0, s.airLeft - dt);
      const u = 1 - s.airLeft / JUMP_SECONDS;
      s.y = 4 * JUMP_HEIGHT * u * (1 - u);
    } else s.y = 0;
    this.gen.ensure(s.z + 150);
    for (const o of this.gen.between(s.z - DOG_HALF_LEN, s.z + DOG_HALF_LEN)) {
      if (Math.abs(s.x - o.lane) >= HIT_HALF_WIDTH || s.y >= HEIGHT[o.kind]) continue;
      s.alive = false;
      s.cause = o.kind === 'train' ? 'Ran into a train.' : o.kind === 'wall' ? 'Hit a wall across the track.' : 'Tripped over a barrier.';
      return;
    }
  }
}
