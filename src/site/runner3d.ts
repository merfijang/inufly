// The dog's run in 3D. The course is rebuilt here from the attempt's seed with the same generator
// the server runs, so the wire only carries where the dog is; this view just draws it.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CourseGen, SPAN, TRAIN_HEIGHT, zAt, type Obstacle, type ObstacleKind } from '../game/runner';
import type { AttemptStart, Frame } from '../shared/protocol';

const LANE_W = 2.4;
const COLORS = { ground: 0x06070a, green: 0x3dff88, greenFaint: 0x155c33, amber: 0xf0bc5f, cyan: 0x7deaff, red: 0xff5a4e, steel: 0x2a303b };
const AHEAD = 190, BEHIND = 12, TRACK_PERIOD = 4, SCENERY_EVERY = 12;

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

/** Diagonal warning stripes, as on the game's barriers. */
function stripeTexture(a: string, b: string) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = a; g.fillRect(0, 0, 128, 32);
  g.fillStyle = b;
  for (let x = -32; x < 160; x += 32) { g.beginPath(); g.moveTo(x, 32); g.lineTo(x + 16, 32); g.lineTo(x + 32, 0); g.lineTo(x + 16, 0); g.fill(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Runner3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 420);
  private readonly world = new THREE.Group();
  private readonly track: THREE.Mesh;
  private readonly grid: THREE.GridHelper;
  private readonly scenery = new THREE.Group();
  private readonly obstacleMeshes = new Map<Obstacle, THREE.Object3D>();
  private readonly pools = new Map<ObstacleKind, THREE.Object3D[]>();
  private readonly mat;
  private dog = new THREE.Group();
  private mixer: THREE.AnimationMixer | null = null;
  private readonly clips = new Map<Clip, THREE.AnimationAction>();
  private clip: Clip | null = null;
  private course: CourseGen | null = null;
  private last: Frame | null = null; private prev: Frame | null = null; private lastAt = 0;
  private shown = { z: 0, x: 0, y: 0, t: 0, crouch: 0 };
  private dead = false; private wasAir = false;
  private readonly clock = new THREE.Clock();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color(COLORS.ground);
    this.scene.fog = new THREE.Fog(COLORS.ground, 50, AHEAD);
    this.scene.add(new THREE.HemisphereLight(0xdff0ff, 0x1a1f28, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(-5, 12, 8); this.scene.add(sun);
    this.scene.add(this.world);
    this.mat = {
      stripe: new THREE.MeshStandardMaterial({ map: stripeTexture('#f0bc5f', '#1a1f28'), emissive: 0x3a2a08, roughness: 0.6 }),
      redStripe: new THREE.MeshStandardMaterial({ map: stripeTexture('#e9ecef', '#d8423a'), emissive: 0x3a0e0a, roughness: 0.6 }),
      post: new THREE.MeshStandardMaterial({ color: COLORS.steel, roughness: 0.8 }),
      lamp: new THREE.MeshBasicMaterial({ color: COLORS.red }),
      body: new THREE.MeshStandardMaterial({ color: 0x2a3342, roughness: 0.55, metalness: 0.2 }),
      movingBody: new THREE.MeshStandardMaterial({ color: 0x3a2e1a, roughness: 0.5, metalness: 0.25 }),
      window: new THREE.MeshBasicMaterial({ color: 0x2b5566 }),
      headlight: new THREE.MeshBasicMaterial({ color: 0xfff1c2 }),
      greenStripe: new THREE.MeshBasicMaterial({ color: COLORS.green }),
      amberStripe: new THREE.MeshBasicMaterial({ color: COLORS.amber }),
      ramp: new THREE.MeshStandardMaterial({ color: COLORS.amber, emissive: 0x2a1c00, roughness: 0.7 }),
      scenery: new THREE.MeshStandardMaterial({ color: 0x10141b, roughness: 0.9 }),
      sceneryEdge: new THREE.LineBasicMaterial({ color: COLORS.greenFaint }),
      lampPost: new THREE.MeshBasicMaterial({ color: COLORS.cyan })
    };

    const tex = trackTexture();
    tex.repeat.set(1, 360 / TRACK_PERIOD);
    this.track = new THREE.Mesh(new THREE.PlaneGeometry(LANE_W * 3, 360), new THREE.MeshBasicMaterial({ map: tex }));
    this.track.rotation.x = -Math.PI / 2;
    this.world.add(this.track);
    this.grid = new THREE.GridHelper(360, 90, COLORS.greenFaint, COLORS.greenFaint);
    (this.grid.material as THREE.Material).transparent = true; (this.grid.material as THREE.Material).opacity = 0.35;
    this.grid.position.y = -0.02;
    this.world.add(this.grid, this.scenery, this.dog);
    this.buildScenery();

    this.loadDog();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.renderer.setAnimationLoop(() => this.render());
  }

  /** Posts, lamps and blocky buildings along both sides; they scroll with the track. */
  private buildScenery() {
    const m = this.mat, rnd = (i: number) => { const x = Math.sin(i * 127.1) * 43758.5453; return x - Math.floor(x); };
    for (let i = 0; i < Math.ceil(360 / SCENERY_EVERY); i++) {
      for (const side of [-1, 1]) {
        const z = -i * SCENERY_EVERY;
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 3.4, 0.16), m.post);
        post.position.set(side * (LANE_W * 1.5 + 0.7), 1.7, z);
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.2), m.lampPost);
        lamp.position.set(side * (LANE_W * 1.5 + 0.45), 3.4, z);
        this.scenery.add(post, lamp);
        const h = 4 + rnd(i * 2 + (side > 0 ? 1 : 0)) * 14, w = 5 + rnd(i * 3 + side) * 6;
        const geo = new THREE.BoxGeometry(w, h, SCENERY_EVERY * 0.8);
        const house = new THREE.Mesh(geo, m.scenery);
        house.position.set(side * (LANE_W * 1.5 + 4 + w / 2 + rnd(i) * 3), h / 2, z - SCENERY_EVERY / 2);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), m.sceneryEdge);
        edges.position.copy(house.position);
        this.scenery.add(house, edges);
      }
    }
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
        if (name === 'Gallop_Jump') action.timeScale = clip.duration / 0.7;
        if (name === 'Gallop') action.timeScale = 1.6;
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
    this.course.ensure(AHEAD + 60);
    this.clearObstacles();
    this.last = this.prev = null; this.shown = { z: 0, x: 0, y: 0, t: 0, crouch: 0 };
    this.dead = false; this.wasAir = false;
    this.play('Gallop');
  }

  frame(f: Frame) {
    this.prev = this.last; this.last = f; this.lastAt = performance.now();
    // running up a ramp or along a roof is running; only being off whatever is underneath is a jump
    const air = !!this.course && f.y > this.course.surface(Math.round(f.x), f.z, f.t) + 0.1;
    if (air && !this.wasAir) this.play('Gallop_Jump', 0.05);
    if (!air && this.wasAir) this.play('Gallop', 0.1);
    this.wasAir = air;
  }

  /** The attempt is over: the dog goes down where it stopped. */
  end() { this.dead = true; this.play('Death', 0.1); }

  /** Between attempts: back to the start line, sitting still. */
  idle() {
    this.course = null; this.clearObstacles();
    this.last = this.prev = null; this.shown = { z: 0, x: 0, y: 0, t: 0, crouch: 0 }; this.dead = false;
    this.play('Idle', 0.3);
  }

  private clearObstacles() {
    for (const [o, mesh] of this.obstacleMeshes) this.release(o, mesh);
    this.obstacleMeshes.clear();
  }

  private release(o: Obstacle, mesh: THREE.Object3D) {
    mesh.visible = false;
    (this.pools.get(o.kind) ?? this.pools.set(o.kind, []).get(o.kind)!).push(mesh);
  }

  private meshFor(o: Obstacle) {
    const mesh = this.pools.get(o.kind)?.pop() ?? this.make(o.kind);
    if (!mesh.parent) this.world.add(mesh);
    mesh.visible = true;
    mesh.scale.z = o.kind === 'train' || o.kind === 'moving' || o.kind === 'ramp' ? o.len : 1;
    return mesh;
  }

  /** One obstacle, centred on its lane at z = 0. Trains and ramps are one metre long, scaled when placed. */
  private make(kind: ObstacleKind): THREE.Object3D {
    const m = this.mat, g = new THREE.Group(), w = LANE_W * 0.86;
    const posts = (h: number) => { for (const x of [-w / 2 + 0.08, w / 2 - 0.08]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.12, h, 0.12), m.post); p.position.set(x, h / 2, 0); g.add(p); } };
    if (kind === 'low') {
      // a low striped barrier: jump it
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.34, 0.16), m.stripe);
      bar.position.y = SPAN.low[1] - 0.17; posts(SPAN.low[1]); g.add(bar);
    } else if (kind === 'roadblock') {
      // a board on legs with a gap underneath: jump it or roll under
      const [bottom, top] = SPAN.roadblock;
      const board = new THREE.Mesh(new THREE.BoxGeometry(w, top - bottom, 0.14), m.redStripe);
      board.position.y = (bottom + top) / 2; posts(top); g.add(board);
      for (const x of [-w / 2 + 0.25, w / 2 - 0.25]) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 0.1), m.lamp); l.position.set(x, top + 0.05, 0); g.add(l); }
    } else if (kind === 'high') {
      // a tall gantry with a striped panel: roll under
      const [bottom, top] = SPAN.high;
      posts(top);
      const panel = new THREE.Mesh(new THREE.BoxGeometry(w, top - bottom, 0.18), m.stripe);
      panel.position.y = (bottom + top) / 2; g.add(panel);
      const sign = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.2), m.lamp); sign.position.y = top + 0.12; g.add(sign);
    } else if (kind === 'ramp') {
      // a wedge from the track (the end nearer the dog, +z) up to a train roof (-z)
      const shape = new THREE.Shape(); shape.moveTo(-0.5, TRAIN_HEIGHT); shape.lineTo(0.5, 0); shape.lineTo(-0.5, 0); shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false });
      geo.rotateY(-Math.PI / 2); geo.translate(w / 2, 0, 0);
      g.add(new THREE.Mesh(geo, m.ramp));
    } else {
      // a train car; an oncoming one is amber with its headlights on the end facing the dog
      const h = TRAIN_HEIGHT, tw = LANE_W * 0.9, moving = kind === 'moving';
      const body = new THREE.Mesh(new THREE.BoxGeometry(tw, h, 1), moving ? m.movingBody : m.body);
      body.position.y = h / 2;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry), new THREE.LineBasicMaterial({ color: moving ? COLORS.amber : COLORS.cyan, transparent: true, opacity: 0.6 }));
      edges.position.copy(body.position);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(tw + 0.02, 0.18, 1.001), moving ? m.amberStripe : m.greenStripe);
      stripe.position.y = h * 0.42;
      const windows = new THREE.Mesh(new THREE.BoxGeometry(tw + 0.02, 0.42, 0.94), m.window);
      windows.position.y = h * 0.68;
      g.add(body, edges, stripe, windows);
      if (moving) for (const x of [-0.6, 0.6]) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.02), m.headlight); l.position.set(x, 0.8, 0.505); g.add(l); }
    }
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
      const speed = this.prev ? Math.max(0, (f.z - this.prev.z) / Math.max(0.001, f.t - this.prev.t)) : 15;
      const ahead = Math.min(0.04, (performance.now() - this.lastAt) / 1000);
      const z = f.z + speed * ahead, k = 1 - Math.exp(-dt * 25);
      this.shown.z = Math.abs(z - this.shown.z) > 8 ? z : this.shown.z + (z - this.shown.z) * Math.min(1, k * 2);
      this.shown.t = f.t + ahead;
      this.shown.x += (f.x - this.shown.x) * k;
      this.shown.y += (f.y - this.shown.y) * Math.min(1, k * 1.6);
    }
    this.shown.crouch += ((this.last?.c && !this.dead ? 1 : 0) - this.shown.crouch) * (1 - Math.exp(-dt * 30));
    const { z, x, y, crouch } = this.shown;
    this.dog.position.set(x * LANE_W, y, -z);
    this.dog.rotation.z = this.last ? -(this.last.x - x) * 0.25 : 0; // lean into a lane change
    this.dog.scale.set(1 + crouch * 0.12, 1 - crouch * 0.5, 1 + crouch * 0.1); // a roll squashes the dog flat

    this.track.position.set(0, 0, -(Math.floor(z / TRACK_PERIOD) * TRACK_PERIOD + 150));
    this.grid.position.z = -(Math.floor(z / 4) * 4 + 150);
    this.scenery.position.z = -Math.floor(z / SCENERY_EVERY) * SCENERY_EVERY + BEHIND * 2;
    this.syncObstacles(z, this.shown.t);

    // the camera rises with the dog onto train roofs
    const camY = Math.max(3.6, y + 3.2);
    this.camera.position.set(x * LANE_W * 0.55, camY, -z + 6.6);
    this.camera.lookAt(x * LANE_W * 0.35, camY - 2.5, -z - 12);
    this.renderer.render(this.scene, this.camera);
  }

  private syncObstacles(z: number, t: number) {
    if (!this.course) return;
    this.course.ensure(z + AHEAD + 60);
    const want = new Set(this.course.between(z - BEHIND, z + AHEAD, t));
    for (const [o, mesh] of this.obstacleMeshes) if (!want.has(o)) { this.release(o, mesh); this.obstacleMeshes.delete(o); }
    for (const o of want) {
      let mesh = this.obstacleMeshes.get(o);
      if (!mesh) { mesh = this.meshFor(o); this.obstacleMeshes.set(o, mesh); }
      mesh.position.set(o.lane * LANE_W, 0, -(zAt(o, t) + o.len / 2));
    }
  }
}
