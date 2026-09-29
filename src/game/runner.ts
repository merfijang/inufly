// A stripped-down Subway Surfers: three lanes, the dog runs on its own and keeps speeding up,
// and the original's obstacles come at it:
//   low barrier  – jump it          roadblock   – jump it or roll under it
//   high barrier – roll under it    train       – change lanes, or run up its ramp onto the roof
//   moving train – comes at you; change lanes
// Pure and seeded: the server runs it for real, and the site rebuilds the same course from the
// seed so only the dog's position has to travel over the wire.

/** Lanes are -1 (left), 0, 1 (right). Distances are metres along the track. */
export type ObstacleKind = 'low' | 'roadblock' | 'high' | 'train' | 'moving' | 'ramp';

/**
 * `z`: where it starts along the track. A moving train is at `z` when the dog would reach `z`
 * (time `meet`), and slides toward the dog at `v` m/s. A ramp rises from the track to the roof of
 * the train right after it.
 */
export interface Obstacle { lane: number; z: number; len: number; kind: ObstacleKind; v?: number; meet?: number }

export interface Course { startSpeed: number; maxSpeed: number; accel: number; firstAt: number; gapMin: number; gapMax: number }

/** Row gaps are in seconds of running: the faster the dog, the further apart in metres. */
export const DEFAULT_COURSE: Course = { startSpeed: 15, maxSpeed: 32, accel: 0.14, firstAt: 40, gapMin: 0.62, gapMax: 1.0 };

/** Vertical extent [bottom, top] of each obstacle, metres. Ramps are ground, not obstacles. */
export const SPAN: Record<Exclude<ObstacleKind, 'ramp'>, [number, number]> = {
  low: [0, 0.75], roadblock: [0.6, 1.2], high: [0.6, 3.2], train: [0, 3.2], moving: [0, 3.2]
};
export const TRAIN_HEIGHT = 3.2;
export const RAMP_LEN = 8;
export const MOVING_SPEED = 9;
export const GRAVITY = 32;
export const JUMP_V = 11.2; // apex ≈ 1.96 m, ≈ 0.7 s in the air
export const ROLL_SECONDS = 0.62;
export const SWITCH_SECONDS = 0.18;
/** The dog's height standing and rolling, half its length, and how far off a lane centre it still counts as in it. */
export const DOG_H = 0.95, ROLL_H = 0.45;
const DOG_HALF_LEN = 0.45, HIT_HALF_WIDTH = 0.5;
/** The most the ground can rise in one step and still be walked onto (a ramp rises ~0.3 m a step). */
export const STEP_UP = 0.8;
/** Feet this close under the top of something still clear it (the dog's front reaches a train roof before its middle does on a ramp). */
export const CLEAR = 0.25;

export type Action = 'left' | 'right' | 'jump' | 'roll';

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

/** Speed at time t, and distance run by time t (the schedule depends on time only). */
export const speedAt = (c: Course, t: number) => Math.min(c.maxSpeed, c.startSpeed + c.accel * t);
export function distanceAt(c: Course, t: number) {
  const tMax = (c.maxSpeed - c.startSpeed) / c.accel;
  if (t <= tMax) return c.startSpeed * t + 0.5 * c.accel * t * t;
  return c.startSpeed * tMax + 0.5 * c.accel * tMax * tMax + c.maxSpeed * (t - tMax);
}
/** When the dog reaches distance z. */
export function timeAt(c: Course, z: number) {
  const tMax = (c.maxSpeed - c.startSpeed) / c.accel, zMax = distanceAt(c, tMax);
  if (z >= zMax) return tMax + (z - zMax) / c.maxSpeed;
  return (-c.startSpeed + Math.sqrt(c.startSpeed * c.startSpeed + 2 * c.accel * z)) / c.accel;
}

/** Where an obstacle starts at time t (moving trains slide toward the dog). */
export const zAt = (o: Obstacle, t: number) => (o.v ? o.z + o.v * (o.meet! - t) : o.z);

const pick = <T>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];

/**
 * The obstacles of one course, generated row by row as the dog gets closer. Every row leaves at
 * least one lane free of trains (a train with a ramp counts as free: the dog can run over it).
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
    const r = this.rand, z = this.nextZ, c = this.course, lanes = [-1, 0, 1];
    const barrier = () => pick(r, ['low', 'low', 'roadblock', 'high'] as const);
    const add = (o: Obstacle) => this.obstacles.push(o);
    let end = z;
    const u = r();
    if (u < 0.3) {
      // one barrier, sometimes two
      const n = r() < 0.35 ? 2 : 1, free = pick(r, lanes);
      for (const lane of lanes.filter((l) => l !== free).slice(0, n)) add({ lane, z, len: 0.4, kind: barrier() });
    } else if (u < 0.42) {
      // a row of barriers across the track, of mixed kinds
      for (const lane of lanes) add({ lane, z, len: 0.4, kind: barrier() });
    } else if (u < 0.62) {
      // parked trains in one or two lanes; one of them may have a ramp; a barrier in the free lane
      const free = pick(r, lanes), blocked = lanes.filter((l) => l !== free);
      const used = r() < 0.5 ? blocked : [pick(r, blocked)], len = 14 + Math.floor(r() * 16);
      const ramp = r() < 0.4 ? pick(r, used) : null;
      for (const lane of used) {
        if (lane === ramp) add({ lane, z, len: RAMP_LEN, kind: 'ramp' });
        add({ lane, z: lane === ramp ? z + RAMP_LEN : z, len, kind: 'train' });
      }
      if (r() < 0.4) add({ lane: free, z: z + 4 + r() * 6, len: 0.4, kind: barrier() });
      end = z + len + (ramp !== null ? RAMP_LEN : 0);
    } else if (u < 0.78) {
      // a train coming the other way, sometimes next to a parked one
      const lane = pick(r, lanes), len = 12 + Math.floor(r() * 8);
      add({ lane, z, len, kind: 'moving', v: MOVING_SPEED, meet: timeAt(c, z) });
      if (r() < 0.45) {
        const other = pick(r, lanes.filter((l) => l !== lane));
        add({ lane: other, z, len: 16, kind: 'train' });
        end = z + 16;
      }
    } else {
      // a long parked train with a ramp in one lane and barriers beside it: the roof is the easy way
      const lane = pick(r, lanes), len = 22 + Math.floor(r() * 18);
      add({ lane, z, len: RAMP_LEN, kind: 'ramp' });
      add({ lane, z: z + RAMP_LEN, len, kind: 'train' });
      for (const other of lanes.filter((l) => l !== lane)) if (r() < 0.6) add({ lane: other, z: z + RAMP_LEN + r() * len, len: 0.4, kind: barrier() });
      end = z + RAMP_LEN + len;
    }
    const speed = speedAt(c, timeAt(c, end));
    this.nextZ = end + speed * (c.gapMin + r() * (c.gapMax - c.gapMin));
  }

  /** Obstacles overlapping [from, to] along the track at time t. */
  between(from: number, to: number, t: number) {
    return this.obstacles.filter((o) => { const s = zAt(o, t); return s + o.len >= from && s <= to; });
  }

  /** Height of whatever the dog would stand on in `lane` at distance z, time t. */
  surface(lane: number, z: number, t: number) {
    let h = 0;
    for (const o of this.obstacles) {
      if (o.lane !== lane) continue;
      const s = zAt(o, t);
      if (z < s || z > s + o.len) continue;
      if (o.kind === 'ramp') h = Math.max(h, (TRAIN_HEIGHT * (z - s)) / o.len);
      else if (o.kind === 'train' || o.kind === 'moving') h = Math.max(h, TRAIN_HEIGHT);
    }
    return h;
  }
}

export interface RunnerState {
  /** seconds since the start */ t: number;
  /** distance run, metres */ z: number;
  speed: number;
  /** lateral position in lanes (-1..1), moving toward `lane` while switching */ x: number;
  lane: number;
  /** height of the dog's feet above the track, metres */ y: number;
  vy: number;
  /** seconds of rolling left (0 = standing) */ rollLeft: number;
  alive: boolean;
  cause: string | null;
}

const CAUSE: Record<Exclude<ObstacleKind, 'ramp'>, string> = {
  low: 'Tripped over a low barrier.', roadblock: 'Hit a roadblock.', high: 'Ran into a high barrier.',
  train: 'Ran into a train.', moving: 'Hit by an oncoming train.'
};

export class RunnerGame {
  readonly gen: CourseGen;
  state: RunnerState;

  constructor(seed: number, readonly course: Course = DEFAULT_COURSE) {
    this.gen = new CourseGen(seed, course);
    this.state = { t: 0, z: 0, speed: course.startSpeed, x: 0, lane: 0, y: 0, vy: 0, rollLeft: 0, alive: true, cause: null };
    this.gen.ensure(200);
  }

  get switching() { return Math.abs(this.state.x - this.state.lane) > 1e-6; }
  /** The lane the dog is over right now (the nearer one while switching). */
  get overLane() { return Math.round(this.state.x); }
  get ground() { const s = this.state; return this.gen.surface(this.overLane, s.z, s.t); }
  get airborne() { return this.state.y > this.ground + 0.02; }
  get rolling() { return this.state.rollLeft > 0; }

  /** Apply one action; returns whether it did anything (a jump in the air or a turn off the edge does not). */
  act(a: Action) {
    const s = this.state;
    if (!s.alive) return false;
    if (a === 'jump') {
      if (this.airborne) return false;
      s.vy = JUMP_V; s.rollLeft = 0; s.y += 0.001;
      return true;
    }
    if (a === 'roll') {
      if (this.rolling) return false;
      s.rollLeft = ROLL_SECONDS;
      if (this.airborne) s.vy = Math.min(s.vy, -18); // in the air, a roll slams the dog down
      return true;
    }
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
    s.speed = speedAt(c, s.t);
    s.z = distanceAt(c, s.t);
    const step = dt / SWITCH_SECONDS;
    s.x = s.x < s.lane ? Math.min(s.lane, s.x + step) : Math.max(s.lane, s.x - step);
    s.rollLeft = Math.max(0, s.rollLeft - dt);
    this.gen.ensure(s.z + 250);

    // the vertical: fly or fall, land on whatever is underneath, and walk up a ramp. A rise too
    // steep to step up (the front of a train) is left to the collision check below.
    const ground = this.ground;
    if (s.vy > 0 || s.y > ground + 0.02) {
      s.vy -= GRAVITY * dt;
      s.y += s.vy * dt;
      if (s.y <= ground && s.y > ground - STEP_UP) { s.y = ground; s.vy = 0; }
    } else if (ground - s.y < STEP_UP) { s.y = ground; s.vy = 0; }

    const h = this.rolling ? ROLL_H : DOG_H;
    for (const o of this.gen.between(s.z - DOG_HALF_LEN, s.z + DOG_HALF_LEN, s.t)) {
      if (o.kind === 'ramp' || Math.abs(s.x - o.lane) >= HIT_HALF_WIDTH) continue;
      const [bottom, top] = SPAN[o.kind];
      if (s.y + CLEAR >= top || s.y + h <= bottom) continue;
      s.alive = false; s.cause = CAUSE[o.kind];
      return;
    }
  }
}
