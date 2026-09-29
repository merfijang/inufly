// Learning curve: one dot per attempt (how far the dog ran), a line for each generation's average.
import type { AttemptRecord } from '../shared/protocol';

export class LearningChart {
  private readonly ctx: CanvasRenderingContext2D;
  private records: AttemptRecord[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  set(records: AttemptRecord[]) { this.records = records.slice(-600); this.draw(); }
  add(record: AttemptRecord) { this.records.push(record); if (this.records.length > 600) this.records.shift(); this.draw(); }

  private draw() {
    const d = Math.min(devicePixelRatio || 1, 2), r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(2, r.width * d); this.canvas.height = Math.max(2, r.height * d);
    const c = this.ctx, W = r.width, H = r.height, pad = { l: 44, r: 8, t: 10, b: 22 };
    c.setTransform(d, 0, 0, d, 0, 0); c.clearRect(0, 0, W, H);
    const recs = this.records, maxFit = Math.max(50, ...recs.map((x) => x.metres)) * 1.1;
    const n0 = recs[0]?.n ?? 1, n1 = Math.max(n0 + 9, recs.at(-1)?.n ?? 1);
    const X = (n: number) => pad.l + ((n - n0) / (n1 - n0 || 1)) * (W - pad.l - pad.r);
    const Y = (v: number) => H - pad.b - (v / maxFit) * (H - pad.t - pad.b);

    c.font = '11px "IBM Plex Mono", ui-monospace, monospace'; c.fillStyle = '#75828d'; c.strokeStyle = '#1a1f28'; c.lineWidth = 1;
    const step = niceStep(maxFit / 4);
    for (let v = 0; v <= maxFit; v += step) {
      c.beginPath(); c.moveTo(pad.l, Y(v) + 0.5); c.lineTo(W - pad.r, Y(v) + 0.5); c.stroke();
      c.textAlign = 'right'; c.fillText(`${v}m`, pad.l - 6, Y(v) + 4);
    }
    c.textAlign = 'left'; c.fillText(`attempt ${n0}`, pad.l, H - 6);
    c.textAlign = 'right'; c.fillText(`${recs.at(-1)?.n ?? 0}`, W - pad.r, H - 6);
    if (!recs.length) { c.textAlign = 'center'; c.fillStyle = '#9dabb7'; c.fillText('The curve starts with the first paid attempt.', W / 2, H / 2); return; }

    c.fillStyle = 'rgba(157,171,183,.5)';
    for (const x of recs) c.fillRect(X(x.n) - 1.5, Y(x.metres) - 1.5, 3, 3);

    const byGen = new Map<number, AttemptRecord[]>();
    for (const x of recs) (byGen.get(x.generation) ?? byGen.set(x.generation, []).get(x.generation)!).push(x);
    c.strokeStyle = '#3dff88'; c.lineWidth = 2; c.beginPath();
    let first = true;
    for (const group of byGen.values()) {
      const mean = group.reduce((s, x) => s + x.metres, 0) / group.length, mid = group.reduce((s, x) => s + x.n, 0) / group.length;
      if (first) c.moveTo(X(mid), Y(mean)); else c.lineTo(X(mid), Y(mean));
      first = false;
    }
    c.stroke();
  }
}

/** 1, 2 or 5 times a power of ten, at least `x`. */
function niceStep(x: number) {
  const p = 10 ** Math.floor(Math.log10(Math.max(1, x)));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= x) ?? 10 * p;
}
