// The dog the fly drives, drawn the same way as the fly above it: a cloud of points sampled from the
// Shiba Inu model's surface. The part a command moves lights up when the fly sends it: the legs for
// a jump, the back for a roll, the head for a turn. While it runs, its legs pump.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { project, rng, type Projection } from './flyShape';

const DOTS = 3600;
type Part = 0 | 1 | 2 | 3; // body, head, legs, tail
const BODY = 0, HEAD = 1, LEGS = 2, TAIL = 3;
const COAT = '#f0bc5f', LIT = '#3dff88';

export class DogSpecimen {
  private readonly ctx: CanvasRenderingContext2D;
  private points = new Float32Array(0);
  private part = new Uint8Array(0);
  /** which legs swing together: +1 / -1, 0 for the rest of the body */
  private phase = new Int8Array(0);
  /** for leg points: 1 at the paw, 0 where the leg meets the body */
  private reach = new Float32Array(0);
  private readonly flash = [0, 0, 0, 0];
  private running = false; private stride = 0; private t = 0;
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly p: Projection = { x: 0, y: 0, depth: 0 };

  constructor(private readonly canvas: HTMLCanvasElement, modelUrl: string) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    new GLTFLoader().load(modelUrl, (gltf) => this.sample(gltf.scene));
    new ResizeObserver(() => this.fit()).observe(canvas);
    this.fit();
    requestAnimationFrame(this.frame);
  }

  /** The fly sent a command: light up the part of the dog it moves. */
  act(a: 'left' | 'right' | 'jump' | 'roll') {
    if (a === 'jump') this.flash[LEGS] = 1;
    else if (a === 'roll') { this.flash[BODY] = 1; this.flash[TAIL] = 1; }
    else this.flash[HEAD] = 1;
  }

  setRunning(on: boolean) { this.running = on; }

  /** Points on the model's surface, normalised to x: tail → head, y: down → up, z: right → left. */
  private sample(scene: THREE.Object3D) {
    scene.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    const raw: number[] = [], v = new THREE.Vector3(), r = rng(11);
    for (const mesh of meshes) {
      // where every vertex really is: through the skeleton for a skinned mesh, then into the world
      const pos = mesh.geometry.getAttribute('position'), skinned = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? (mesh as THREE.SkinnedMesh) : null;
      const at = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        if (skinned) skinned.applyBoneTransform(i, v);
        v.applyMatrix4(mesh.matrixWorld);
        at.set([v.x, v.y, v.z], i * 3);
      }
      // then points spread over the triangles by area, seeded so every viewer sees the same dog
      const index = mesh.geometry.index, tri = index ? index.count / 3 : pos.count / 3, corner = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);
      const area = new Float64Array(tri), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      let total = 0;
      for (let t = 0; t < tri; t++) {
        a.fromArray(at, corner(t, 0) * 3); b.fromArray(at, corner(t, 1) * 3); c.fromArray(at, corner(t, 2) * 3);
        total += b.sub(a).cross(c.sub(a)).length() / 2; area[t] = total;
      }
      const n = Math.round(DOTS / meshes.length);
      for (let i = 0; i < n; i++) {
        const want = r() * total;
        let lo = 0, hi = tri - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (area[mid] < want) lo = mid + 1; else hi = mid; }
        let u = r(), w = r();
        if (u + w > 1) { u = 1 - u; w = 1 - w; }
        a.fromArray(at, corner(lo, 0) * 3); b.fromArray(at, corner(lo, 1) * 3); c.fromArray(at, corner(lo, 2) * 3);
        v.copy(a).addScaledVector(b.sub(a), u).addScaledVector(c.sub(a), w);
        raw.push(v.x, v.y, v.z);
      }
    }
    const count = raw.length / 3, box = new THREE.Box3();
    for (let i = 0; i < count; i++) box.expandByPoint(v.set(raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]));
    const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3()), len = Math.max(size.x, size.z);
    this.points = new Float32Array(count * 3); this.part = new Uint8Array(count); this.phase = new Int8Array(count); this.reach = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // the model faces +z: that becomes +x (head), its x becomes our z
      const x = (raw[i * 3 + 2] - centre.z) / len, y = (raw[i * 3 + 1] - box.min.y) / len - size.y / len / 2, z = (raw[i * 3] - centre.x) / len;
      this.points.set([x, y, z], i * 3);
      const h = (raw[i * 3 + 1] - box.min.y) / size.y, low = h < 0.42;
      this.reach[i] = low ? 1 - h / 0.42 : 0;
      const part: Part = low ? LEGS : x > 0.22 ? HEAD : x < -0.36 ? TAIL : BODY;
      this.part[i] = part;
      // front-left with back-right, front-right with back-left: a trot
      this.phase[i] = part === LEGS ? ((x > 0) === (z > 0) ? 1 : -1) : 0;
    }
  }

  private fit() {
    const r = this.canvas.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(2, Math.floor(r.width * d));
    this.canvas.height = Math.max(2, Math.floor(r.height * d));
  }

  private readonly frame = () => {
    const c = this.ctx, W = this.canvas.width, H = this.canvas.height, dpr = Math.min(devicePixelRatio || 1, 2), p = this.p;
    c.globalAlpha = 1; c.fillStyle = '#06070a'; c.fillRect(0, 0, W, H);
    const yaw = -0.75 + (this.reduced ? 0 : Math.sin(this.t * 0.15) * 0.18), pitch = 0.22;
    const S = Math.min(W * 0.72, H * 1.25), cx = W * 0.5, cy = H * 0.55;
    this.stride += ((this.running ? 1 : 0) - this.stride) * 0.06;
    const swing = Math.sin(this.t * 9) * 0.06 * this.stride;
    const count = this.part.length;
    for (let i = 0; i < count; i++) {
      let x = this.points[i * 3], y = this.points[i * 3 + 1];
      const z = this.points[i * 3 + 2], part = this.part[i];
      if (part === LEGS) { const k = this.reach[i]; x += this.phase[i] * swing * k; y += Math.max(0, this.phase[i] * swing) * k * 0.6; }
      if (this.flash[BODY] > 0.02 && part !== LEGS) y -= this.flash[BODY] * 0.05; // a roll ducks the body
      project([x, y, z], yaw, pitch, p);
      const near = Math.max(0, Math.min(1, p.depth + 0.5)), lit = this.flash[part];
      c.fillStyle = lit > 0.35 ? LIT : COAT;
      c.globalAlpha = Math.min(1, 0.45 + near * 0.4 + lit * 0.5);
      const s = (1 + near * 0.8 + lit * 1.2) * dpr;
      c.fillRect(cx - p.x * S - s / 2, cy - p.y * S - s / 2, s, s);
    }
    c.globalAlpha = 1;
    for (let k = 0; k < 4; k++) this.flash[k] *= 0.9;
    if (!this.reduced) this.t += 0.016;
    requestAnimationFrame(this.frame);
  };
}
