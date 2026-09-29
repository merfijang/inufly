// Point-cloud fly: a faint body silhouette with the nervous system inside it.
// Neuron points sit where that part of the CNS is in a real fly (schematic, not traced).
import { REGIONS, ROLE } from '../shared/display';

export type Vec = [number, number, number];

/** Seeded RNG so the fly looks the same for every viewer. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function gauss(r: () => number) { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }

/** Random point in (shell > 0: near the surface of) an ellipsoid. */
function inEllipsoid(r: () => number, c: Vec, rad: Vec, shell = 0): Vec {
  let x = gauss(r), y = gauss(r), z = gauss(r); const d = Math.hypot(x, y, z) || 1;
  const k = shell > 0 ? 1 - shell * r() : Math.cbrt(r());
  x = (x / d) * k; y = (y / d) * k; z = (z / d) * k;
  return [c[0] + x * rad[0], c[1] + y * rad[1], c[2] + z * rad[2]];
}

// x: tail → head, y: down → up, z: right → left. Units ≈ body length.
const OPTIC = (side: 1 | -1): Vec => [0.44, 0.045, side * 0.112];
const BRAIN: Vec = [0.445, 0.05, 0];
const NEUROMERES = [0.18, 0.09, 0.02];

function legPath(leg: number, t: number, r: () => number): Vec {
  const side = leg < 3 ? 1 : -1, seg = leg % 3, rootX = NEUROMERES[seg];
  if (t < 0.25) { const u = t / 0.25; return [rootX, -0.05 - u * 0.06, side * (0.04 + u * 0.08)]; } // nerve out of the VNC
  const u = (t - 0.25) / 0.75, knee = Math.min(1, u / 0.4), foot = Math.max(0, (u - 0.4) / 0.6);
  return [rootX - knee * 0.06 - foot * 0.14 * (seg === 2 ? 1.6 : 1), -0.11 - knee * 0.18 - foot * 0.2, side * (0.12 + knee * 0.1 + foot * 0.06) + gauss(r) * 0.006];
}

/** Where a displayed neuron is drawn. */
export function neuronPoint(region: number, role: number, r: () => number): Vec {
  if (role === ROLE.input) {
    // visual projection neurons: the band from the optic lobe to the central brain
    const side = REGIONS[region] === 'opticR' ? -1 : 1, t = 0.3 + r() * 0.45, o = OPTIC(side);
    return [o[0] + (BRAIN[0] - o[0]) * t + gauss(r) * 0.01, o[1] + (BRAIN[1] - o[1]) * t + gauss(r) * 0.018, o[2] + (BRAIN[2] - o[2]) * t + gauss(r) * 0.008];
  }
  switch (REGIONS[region]) {
    case 'opticL': return inEllipsoid(r, OPTIC(1), [0.055, 0.1, 0.042], 0.35);
    case 'opticR': return inEllipsoid(r, OPTIC(-1), [0.055, 0.1, 0.042], 0.35);
    case 'brain': return inEllipsoid(r, BRAIN, [0.07, 0.07, 0.07]);
    case 'neck': { const t = r(); return [0.35 - t * 0.12, 0.005 - t * 0.035 + gauss(r) * 0.012, gauss(r) * 0.016]; }
    case 'vnc': return inEllipsoid(r, [NEUROMERES[Math.floor(r() * 3)], -0.045, 0], [0.045, 0.032, 0.05]);
    case 'abdominal': { const t = r(); return [-0.02 - t * 0.09, -0.045 + gauss(r) * 0.012, gauss(r) * (0.022 * (1 - t) + 0.006)]; }
    case 'motor': return legPath(Math.floor(r() * 6), r(), r); // motor neurons, drawn along their leg nerves
    // sensory neurons live in the periphery, where they sense
    case 'retinaL': return inEllipsoid(r, EYE(1), [0.1, 0.13, 0.09], 0.12); // photoreceptors in the compound eye
    case 'retinaR': return inEllipsoid(r, EYE(-1), [0.1, 0.13, 0.09], 0.12);
    case 'headSense': return r() < 0.35 ? antennaPoint(r) : inEllipsoid(r, [0.43, 0.03, 0], [0.15, 0.15, 0.13], 0.1);
    case 'bodySense': return surfacePoint(r);
    case 'wingL': return wingPoint(1, r);
    case 'wingR': return wingPoint(-1, r);
    default: { const p = inEllipsoid(r, [-0.37, 0, 0], [0.24, 0.1, 0.09]); p[1] -= (p[0] + 0.37) ** 2 * 0.25; return p; } // gut (enteric neurons)
  }
}

const EYE = (side: 1 | -1): Vec => [0.47, 0.06, side * 0.15];

function antennaPoint(r: () => number): Vec {
  const side = r() < 0.5 ? 1 : -1, t = r();
  return [0.56 + t * 0.06, 0.07 + t * 0.03 + gauss(r) * 0.008, side * (0.035 + t * 0.02) + gauss(r) * 0.006];
}

/** A point on the thorax, abdomen or legs: where bristle and leg sensory neurons sit. */
function surfacePoint(r: () => number): Vec {
  const pick = r();
  if (pick < 0.35) return inEllipsoid(r, [0.1, 0.03, 0], [0.22, 0.2, 0.18], 0.06);
  if (pick < 0.8) { const p = inEllipsoid(r, [-0.37, 0, 0], [0.36, 0.19, 0.18], 0.06); p[1] -= (p[0] + 0.37) ** 2 * 0.25; return p; }
  return legPath(Math.floor(r() * 6), 0.25 + r() * 0.75, r);
}

/** Faint outline of the body the nervous system lives in (not neurons). */
export function bodyPoint(r: () => number): Vec {
  const pick = r();
  if (pick < 0.16) return inEllipsoid(r, [0.43, 0.03, 0], [0.15, 0.15, 0.13], 0.08);
  if (pick < 0.3) return inEllipsoid(r, EYE(r() < 0.5 ? 1 : -1), [0.1, 0.13, 0.09], 0.1);
  return surfacePoint(r);
}

/** Wing membrane points; `side` 1 = left wing. Resting pose, folded back over the body. */
export function wingPoint(side: 1 | -1, r: () => number): Vec {
  const t = Math.sqrt(r()), w = 0.3 * Math.sin(Math.PI * Math.min(1, t * 0.98)), a = r() - 0.5;
  return [0.06 - t * 0.74, 0.21 + t * 0.05, side * (0.07 + t * 0.26 + a * w)];
}

export interface Projection { x: number; y: number; depth: number }

/** Rotate about the vertical axis (sway) and tilt, then project with a light perspective. */
export function project(p: Vec, yaw: number, pitch: number, out: Projection) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const x1 = p[0] * cy - p[2] * sy, z1 = p[0] * sy + p[2] * cy;
  const y2 = p[1] * cp - z1 * sp, z2 = p[1] * sp + z1 * cp;
  const f = 1 / (1 - z2 * 0.25);
  out.x = x1 * f; out.y = y2 * f; out.depth = z2;
  return out;
}
