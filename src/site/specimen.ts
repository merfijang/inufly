// The specimen: a faint fly body with its nervous system inside. Every coloured dot is one real
// neuron of the running connectome, coloured by region. A region glows when it fires more than
// its own recent average; track-input and move-readout neurons are drawn larger in their own colours.
import { REGIONS, ROLE } from '../shared/display';
import { bodyPoint, neuronPoint, project, rng, wingPoint, type Projection, type Vec } from './flyShape';

// order follows REGIONS: optic ×2, brain, neck, vnc, abdominal, motor, retina ×2, head sense, body sense, wing ×2, gut
export const REGION_COLORS = ['#5cc8ff', '#5cc8ff', '#a98bff', '#f7a08a', '#46d6a4', '#9be7c9', '#ff6f91', '#8fe9ff', '#8fe9ff', '#d0b8ff', '#c3d2ee', '#a8d8ff', '#a8d8ff', '#ffd29a'];
/** Sensory neurons in the periphery: they twinkle with their own spikes, no region glow. */
const PERIPHERAL = new Set<string>(['retinaL', 'retinaR', 'headSense', 'bodySense', 'wingL', 'wingR', 'gut']);
const WING = new Set<string>(['wingL', 'wingR']);
export const ROLE_COLORS = { input: '#7deaff', readout: '#3dff88' };

const BODY_DOTS = 2600, WING_DOTS = 900;
const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

export class Specimen {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly body = new Float32Array(BODY_DOTS * 3);
  private readonly wings = new Float32Array(WING_DOTS * 3);
  private points = new Float32Array(0);
  private region: Uint8Array = new Uint8Array(0);
  private role: Uint8Array = new Uint8Array(0);
  private heat = new Float32Array(0);
  private regionSize = new Float32Array(REGIONS.length);
  private readonly centroid: Vec[] = REGIONS.map(() => [0, 0, 0]);
  private readonly baseline = new Float32Array(REGIONS.length).fill(-1);
  private readonly glow = new Float32Array(REGIONS.length);
  private readonly glowTarget = new Float32Array(REGIONS.length);
  private count = 0; private wingFlash = 0; private readoutFlash = 0;
  private pointer = 0; private pointerTarget = 0; private t = 0;
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly p: Projection = { x: 0, y: 0, depth: 0 };

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    const r = rng(7);
    for (let i = 0; i < BODY_DOTS; i++) this.body.set(bodyPoint(r), i * 3);
    for (let i = 0; i < WING_DOTS; i++) this.wings.set(wingPoint(i % 2 ? 1 : -1, r), i * 3);
    new ResizeObserver(() => this.fit()).observe(canvas);
    window.addEventListener('pointermove', (e: PointerEvent) => { this.pointerTarget = (e.clientX / innerWidth - 0.5) * 0.5; });
    this.fit();
    requestAnimationFrame(this.frame);
  }

  /** One dot per displayed neuron, placed by region and role. */
  setNeurons(region: Uint8Array, role: Uint8Array) {
    const r = rng(1);
    this.count = region.length; this.region = region; this.role = role;
    this.points = new Float32Array(this.count * 3); this.heat = new Float32Array(this.count);
    this.regionSize.fill(0); this.centroid.forEach((c) => c.fill(0));
    for (let k = 0; k < this.count; k++) {
      const pt = neuronPoint(region[k], role[k], r);
      this.points.set(pt, k * 3);
      const c = this.centroid[region[k]]; c[0] += pt[0]; c[1] += pt[1]; c[2] += pt[2]; this.regionSize[region[k]]++;
    }
    this.centroid.forEach((c, i) => { const n = Math.max(1, this.regionSize[i]); c[0] /= n; c[1] /= n; c[2] /= n; });
  }

  /** Bits from the server: 1 = fired in the last 100 ms. Updates per-region excitation too. */
  activity(bits: Uint8Array) {
    const fired = new Float32Array(REGIONS.length);
    for (let k = 0; k < this.count; k++) if (bits[k]) { this.heat[k] = 1; fired[this.region[k]]++; }
    for (let i = 0; i < REGIONS.length; i++) {
      const rate = fired[i] / Math.max(1, this.regionSize[i]);
      if (this.baseline[i] < 0) this.baseline[i] = rate;
      // excitation = how far above its own slow-moving average the region is firing right now
      this.glowTarget[i] = Math.max(0, Math.min(1, (rate / Math.max(1e-4, this.baseline[i]) - 1) * 2.2));
      this.baseline[i] += (rate - this.baseline[i]) * 0.02;
    }
  }

  flap() { this.wingFlash = 1; this.readoutFlash = 1; }

  private fit() {
    const r = this.canvas.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(2, Math.floor(r.width * d));
    this.canvas.height = Math.max(2, Math.floor(r.height * d));
  }

  private readonly frame = () => {
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height, dpr = Math.min(devicePixelRatio || 1, 2), p = this.p;
    c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
    c.fillStyle = '#06070a'; c.fillRect(0, 0, W, H);
    this.pointer += (this.pointerTarget - this.pointer) * 0.05;
    const yaw = (this.reduced ? 0 : Math.sin(this.t * 0.17) * 0.22) + this.pointer, pitch = 0.58;
    const S = Math.min(W * 0.66, H * 1.1), cx = W * 0.46, cy = H * 0.5;
    const X = () => cx - p.x * S, Y = () => cy - p.y * S;

    // body outline and wings: context only, never lit
    c.fillStyle = '#9fb2d4';
    for (let i = 0; i < BODY_DOTS; i++) {
      project([this.body[i * 3], this.body[i * 3 + 1], this.body[i * 3 + 2]], yaw, pitch, p);
      c.globalAlpha = 0.13 + Math.max(0, p.depth + 0.5) * 0.17;
      c.fillRect(X(), Y(), dpr, dpr);
    }
    const lift = this.wingFlash;
    for (let i = 0; i < WING_DOTS; i++) {
      const x = this.wings[i * 3], y = this.wings[i * 3 + 1] + lift * (0.2 - x) * 0.35, z = this.wings[i * 3 + 2] * (1 + lift * 0.4);
      project([x, y, z], yaw, pitch, p);
      c.globalAlpha = 0.09 + Math.max(0, p.depth + 0.5) * 0.1 + lift * 0.22;
      c.fillRect(X(), Y(), 0.9 * dpr, 0.9 * dpr);
    }

    // region glows, additive, driven by excitation above baseline
    c.globalCompositeOperation = 'lighter';
    for (let i = 0; i < REGIONS.length; i++) {
      this.glow[i] += (this.glowTarget[i] - this.glow[i]) * 0.12;
      const g = this.glow[i] + (REGIONS[i] === 'neck' ? this.readoutFlash * 0.6 : 0);
      if (g < 0.02 || !this.regionSize[i] || PERIPHERAL.has(REGIONS[i])) continue;
      project(this.centroid[i], yaw, pitch, p);
      const rad = S * (REGIONS[i] === 'vnc' ? 0.16 : REGIONS[i] === 'brain' ? 0.12 : 0.1), [r, gg, b] = hex(REGIONS[i] === 'neck' ? ROLE_COLORS.readout : REGION_COLORS[i]);
      const grad = c.createRadialGradient(X(), Y(), 0, X(), Y(), rad);
      grad.addColorStop(0, `rgba(${r},${gg},${b},${Math.min(0.55, g * 0.45)})`); grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
      c.globalAlpha = 1; c.fillStyle = grad; c.fillRect(X() - rad, Y() - rad, rad * 2, rad * 2);
    }
    c.globalCompositeOperation = 'source-over';

    for (let k = 0; k < this.count; k++) {
      const reg = this.region[k], role = this.role[k], name = REGIONS[reg], wing = WING.has(name);
      let x = this.points[k * 3], y = this.points[k * 3 + 1], z = this.points[k * 3 + 2];
      if (wing) { y += lift * (0.2 - x) * 0.35; z *= 1 + lift * 0.4; } // wing sensors ride on the wing
      project([x, y, z], yaw, pitch, p);
      const near = Math.max(0, Math.min(1, p.depth + 0.5));
      let h = this.heat[k];
      if (role === ROLE.readout) h = Math.max(h, this.readoutFlash);
      if (wing) h = Math.max(h, lift * 0.9); // the wings light up with every flap
      // central chatter twinkles faintly and shines where a region is excited; the periphery twinkles with its own spikes
      const shine = role ? h : PERIPHERAL.has(name) ? h * 0.75 : h * (0.3 + 0.7 * this.glow[reg]);
      c.fillStyle = role === ROLE.input ? ROLE_COLORS.input : role === ROLE.readout ? ROLE_COLORS.readout : shine > 0.45 ? '#f4fbff' : REGION_COLORS[reg];
      c.globalAlpha = Math.min(1, (role ? 0.3 : 0.2) + near * 0.25 + shine * 0.8);
      const s = ((role ? 1.05 : 0.8) + near * 0.5 + shine * 1.4) * dpr;
      c.fillRect(X() - s / 2, Y() - s / 2, s, s);
      if (this.heat[k] > 0) this.heat[k] = this.heat[k] < 0.03 ? 0 : this.heat[k] * 0.84;
    }
    c.globalAlpha = 1;
    this.wingFlash *= 0.86; this.readoutFlash *= 0.9;
    if (!this.reduced) this.t += 0.016;
    requestAnimationFrame(this.frame);
  };
}
