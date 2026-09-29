// The dog's run in 3D. The course is rebuilt here from the attempt's seed with the same generator
// the server runs, so the wire only carries where the dog is; this view just draws it.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CourseGen, HEIGHT, JUMP_SECONDS, type Obstacle } from '../game/runner';
import type { AttemptStart, Frame } from '../shared/protocol';

const LANE_W = 2.4;
const COLORS = { ground: 0x06070a, plate: 0x0b0d12, line: 0x1a1f28, green: 0x3dff88, greenDim: 0x1f8f4d, greenFaint: 0x155c33, amber: 0xf0bc5f, cyan: 0x7deaff, ink: 0xe2eaf1 };
const AHEAD = 160, BEHIND = 12, TRACK_PERIOD = 4;

type Clip = 'Idle' | 'Gallop' | 'Gallop_Jump' | 'Death';

/** Lane lines and sleepers, repeated down the track. */
function trackTexture() {
  const c = document.createElement('canvas'); c.width = 384; c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0b0d12'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#10141b';
  for (let y = 8; y < c.height; y += 32) for (const lane of [0, 1, 2]) g.fillRect(lane * 128 + 22, y, 84, 10); // sleepers
  g.fillStyle = '#1a1f28';
  for (const lane of [0, 1, 2]) { g.fillRect(lane * 128 + 34, 0, 5, c.height); g.fillRect(lane * 128 + 89, 0, 5, c.height); } // rails
  g.fillStyle = '#1f8f4d';
  for (const x of [0, 127, 255, 383]) g.fillRect(x - 1, 0, 2, c.height); // lane edges
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class Runner3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(58, 1, 0.1, 400);
  private readonly world = new THREE.Group();
  private readonly track: THREE.Mesh;
  private readonly grid: THREE.GridHelper;
  private readonly obstacleMeshes = new Map<Obstacle, THREE.Object3D>();
  private readonly pools: Record<'low' | 'train', THREE.Object3D[]> = { low: [], train: [] };
  private dog = new THREE.Group();
  private mixer: THREE.AnimationMixer | null = null;
  private readonly clips = new Map<Clip, THREE.AnimationAction>();
  private clip: Clip | null = null;
  private course: CourseGen | null = null;
  private last: Frame | null = null; private prev: Frame | null = null; private lastAt = 0;
  private shown = { z: 0, x: 0, y: 0 };
  private dead = false; private wasAir = false;
  private readonly clock = new THREE.Clock();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color(COLORS.ground);
    this.scene.fog = new THREE.Fog(COLORS.ground, 40, AHEAD);
    this.scene.add(new THREE.HemisphereLight(0xdff0ff, 0x1a1f28, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(-5, 12, 8); this.scene.add(sun);
    this.scene.add(this.world);

    const tex = trackTexture();
    tex.repeat.set(1, 300 / TRACK_PERIOD);
    this.track = new THREE.Mesh(new THREE.PlaneGeometry(LANE_W * 3, 300), new THREE.MeshBasicMaterial({ map: tex }));
    this.track.rotation.x = -Math.PI / 2;
    this.world.add(this.track);
    this.grid = new THREE.GridHelper(300, 75, COLORS.greenFaint, COLORS.greenFaint);
    (this.grid.material as THREE.Material).transparent = true; (this.grid.material as THREE.Material).opacity = 0.35;
    this.grid.position.y = -0.02;
    this.world.add(this.grid);
    this.world.add(this.dog);

    this.loadDog();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.renderer.setAnimationLoop(() => this.render());
  }

  private loadDog() {
    new GLTFLoader().load(`${import.meta.env.BASE_URL}models/shiba.glb`, (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3());
      const scale = 1.9 / Math.max(size.x, size.z);
      model.scale.setScalar(scale);
      model.position.y = -box.min.y * scale;
      model.rotation.y = Math.PI; // the model faces +z; the dog runs toward -z
      this.dog.add(model);
      this.mixer = new THREE.AnimationMixer(model);
      for (const name of ['Idle', 'Gallop', 'Gallop_Jump', 'Death'] as Clip[]) {
        const clip = gltf.animations.find((a) => a.name === name) ?? gltf.animations.find((a) => a.name.endsWith(`|${name}`));
        if (!clip) continue;
        const action = this.mixer.clipAction(clip);
        if (name === 'Death' || name === 'Gallop_Jump') { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; }
        if (name === 'Gallop_Jump') action.timeScale = clip.duration / JUMP_SECONDS;
        this.clips.set(name, action);
      }
      this.play(this.dead ? 'Death' : this.last ? 'Gallop' : 'Idle', 0);
    });
  }

  private play(name: Clip, fade = 0.15) {
    const next = this.clips.get(name);
    if (!next || (this.clip === name && name !== 'Gallop_Jump')) return;
    const cur = this.clip ? this.clips.get(this.clip) : undefined;
    next.reset().play();
    if (cur && cur !== next && fade > 0) cur.crossFadeTo(next, fade, false); else if (cur && cur !== next) cur.stop();
    this.clip = name;
  }

  /** A new attempt: build its course and put the dog at the start. */
  start(a: AttemptStart) {
    this.course = new CourseGen(a.seed, a.course);
    this.course.ensure(AHEAD + 50);
    this.clearObstacles();
    this.last = this.prev = null; this.shown = { z: 0, x: 0, y: 0 };
    this.dead = false; this.wasAir = false;
    this.play('Gallop');
  }

  frame(f: Frame) {
    this.prev = this.last; this.last = f; this.lastAt = performance.now();
    if (f.y > 0 && !this.wasAir) this.play('Gallop_Jump', 0.05);
    if (f.y === 0 && this.wasAir) this.play('Gallop', 0.1);
    this.wasAir = f.y > 0;
  }

  /** The attempt is over: the dog goes down where it stopped. */
  end() { this.dead = true; this.play('Death', 0.1); }

  /** Between attempts: back to the start line, sitting still. */
  idle() {
    this.course = null; this.clearObstacles();
    this.last = this.prev = null; this.shown = { z: 0, x: 0, y: 0 }; this.dead = false;
    this.play('Idle', 0.3);
  }

  private clearObstacles() {
    for (const [o, mesh] of this.obstacleMeshes) this.release(o, mesh);
    this.obstacleMeshes.clear();
  }

  private release(o: Obstacle, mesh: THREE.Object3D) {
    mesh.visible = false;
    this.pools[o.kind === 'train' ? 'train' : 'low'].push(mesh);
  }

  private meshFor(o: Obstacle) {
    const pool = this.pools[o.kind === 'train' ? 'train' : 'low'];
    const mesh = pool.pop() ?? (o.kind === 'train' ? this.makeTrain() : this.makeBarrier());
    if (!mesh.parent) this.world.add(mesh);
    mesh.visible = true;
    if (o.kind === 'train') mesh.scale.z = o.len;
    mesh.position.set(o.lane * LANE_W, 0, -(o.z + (o.kind === 'train' ? o.len / 2 : o.len / 2)));
    return mesh;
  }

  private makeBarrier() {
    const g = new THREE.Group(), h = HEIGHT.barrier;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(LANE_W * 0.86, 0.26, 0.2), new THREE.MeshStandardMaterial({ color: COLORS.amber, emissive: COLORS.amber, emissiveIntensity: 0.35, roughness: 0.6 }));
    bar.position.y = h - 0.13;
    const legMat = new THREE.MeshStandardMaterial({ color: 0x2a303b, roughness: 0.8 });
    for (const x of [-0.85, 0.85]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, h, 0.12), legMat); leg.position.set(x, h / 2, 0); g.add(leg); }
    g.add(bar);
    return g;
  }

  /** A unit-length train car along z; scaled to the obstacle's length when placed. */
  private makeTrain() {
    const g = new THREE.Group(), h = HEIGHT.train, w = LANE_W * 0.88;
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, 1), new THREE.MeshStandardMaterial({ color: 0x2a3342, roughness: 0.55, metalness: 0.2 }));
    body.position.y = h / 2;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), new THREE.LineBasicMaterial({ color: COLORS.cyan, transparent: true, opacity: 0.55 }));
    edges.position.copy(body.position);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.18, 1.001), new THREE.MeshBasicMaterial({ color: COLORS.green }));
    stripe.position.y = h * 0.42;
    g.add(body, edges, stripe);
    return g;
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
  }

  private render() {
    const dt = Math.min(0.05, this.clock.getDelta());
    this.mixer?.update(dt);
    const f = this.last;
    if (f && !this.dead) {
      // extrapolate a little past the newest frame so 50 Hz frames look smooth at any refresh rate
      const speed = this.prev ? Math.max(0, (f.z - this.prev.z) / Math.max(0.001, f.t - this.prev.t)) : 10;
      const ahead = Math.min(0.04, (performance.now() - this.lastAt) / 1000);
      const z = f.z + speed * ahead, k = 1 - Math.exp(-dt * 25);
      this.shown.z = Math.abs(z - this.shown.z) > 5 ? z : this.shown.z + (z - this.shown.z) * Math.min(1, k * 2);
      this.shown.x += (f.x - this.shown.x) * k;
      this.shown.y += (f.y - this.shown.y) * Math.min(1, k * 1.5);
    }
    const { z, x, y } = this.shown;
    this.dog.position.set(x * LANE_W, y, -z);
    this.dog.rotation.z = this.last ? -(this.last.x - x) * 0.25 : 0; // lean into a lane change

    const snap = Math.floor(z / TRACK_PERIOD) * TRACK_PERIOD;
    this.track.position.set(0, 0, -(snap + 120));
    this.grid.position.z = -(Math.floor(z / 4) * 4 + 120);
    this.syncObstacles(z);

    const camTarget = new THREE.Vector3(x * LANE_W * 0.35, 1.1, -z - 12);
    this.camera.position.set(x * LANE_W * 0.55, 3.6, -z + 6.4);
    this.camera.lookAt(camTarget);
    this.renderer.render(this.scene, this.camera);
  }

  private syncObstacles(z: number) {
    if (!this.course) return;
    this.course.ensure(z + AHEAD + 50);
    const want = new Set(this.course.between(z - BEHIND, z + AHEAD));
    for (const [o, mesh] of this.obstacleMeshes) if (!want.has(o)) { this.release(o, mesh); this.obstacleMeshes.delete(o); }
    for (const o of want) if (!this.obstacleMeshes.has(o)) this.obstacleMeshes.set(o, this.meshFor(o));
  }
}
