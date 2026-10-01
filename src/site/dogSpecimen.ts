// The dog the fly drives, shown under the fly: the Shiba Inu model itself, in its own colours,
// turning slowly. It gallops while a run plays, jumps when the fly jumps and sits idle between runs.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

type Clip = 'Idle' | 'Gallop' | 'Gallop_Jump';

export class DogSpecimen {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  private readonly turntable = new THREE.Group();
  private mixer: THREE.AnimationMixer | null = null;
  private readonly clips = new Map<Clip, THREE.AnimationAction>();
  private clip: Clip | null = null;
  private running = false;
  private readonly clock = new THREE.Clock();
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(private readonly canvas: HTMLCanvasElement, modelUrl: string) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color(0x06070a);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x2a303b, 2.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(3, 5, 4); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x7deaff, 1.2); rim.position.set(-4, 3, -4); this.scene.add(rim);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(1.25, 48), new THREE.MeshBasicMaterial({ color: 0x0b0d12 }));
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor, this.turntable);
    this.camera.position.set(0, 1.25, 4.4);
    this.camera.lookAt(0, 0.55, 0);

    new GLTFLoader().load(modelUrl, (gltf) => {
      const model = gltf.scene, box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3());
      const scale = 1.9 / Math.max(size.x, size.z);
      model.scale.setScalar(scale);
      model.position.set(-((box.min.x + box.max.x) / 2) * scale, -box.min.y * scale, -((box.min.z + box.max.z) / 2) * scale);
      this.turntable.add(model);
      this.mixer = new THREE.AnimationMixer(model);
      for (const name of ['Idle', 'Gallop', 'Gallop_Jump'] as Clip[]) {
        const clip = gltf.animations.find((a) => a.name === name) ?? gltf.animations.find((a) => a.name.endsWith(`|${name}`));
        if (!clip) continue;
        const action = this.mixer.clipAction(clip);
        if (name === 'Gallop_Jump') { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.timeScale = clip.duration / 0.7; }
        this.clips.set(name, action);
      }
      this.mixer.addEventListener('finished', () => this.play(this.running ? 'Gallop' : 'Idle', 0.15));
      this.play(this.running ? 'Gallop' : 'Idle', 0);
    });
    new ResizeObserver(() => this.fit()).observe(canvas);
    this.fit();
    this.renderer.setAnimationLoop(() => this.render());
  }

  /** The fly sent a command; the dog here jumps along with the one on the track. */
  act(a: 'left' | 'right' | 'jump' | 'roll') { if (a === 'jump') this.play('Gallop_Jump', 0.05); }

  setRunning(on: boolean) {
    this.running = on;
    if (this.clip !== 'Gallop_Jump') this.play(on ? 'Gallop' : 'Idle', 0.3);
  }

  private play(name: Clip, fade: number) {
    const next = this.clips.get(name);
    if (!next || (this.clip === name && name !== 'Gallop_Jump')) return;
    const cur = this.clip ? this.clips.get(this.clip) : undefined;
    next.reset().play();
    if (cur && cur !== next) { if (fade > 0) cur.crossFadeTo(next, fade, false); else cur.stop(); }
    this.clip = name;
  }

  private fit() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
  }

  private render() {
    const dt = Math.min(0.05, this.clock.getDelta());
    this.mixer?.update(dt);
    if (!this.reduced) this.turntable.rotation.y += dt * 0.35;
    this.renderer.render(this.scene, this.camera);
  }
}
