// Where attempts get computed. A brain step is single-threaded, so the way to use more cores is to
// run several attempts at once: the samples of one ES generation are independent of each other.
import { cpus } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { AttemptResult, AttemptRunner, Job } from './attempt';
import type { Readout } from '../src/core/policy';

export interface Computer {
  /** how many attempts can run at the same time */ readonly size: number;
  run(job: Job): Promise<AttemptResult>;
  close(): Promise<void>;
}

/** In the calling thread, one at a time (tests, and machines with one core). */
export class InlineComputer implements Computer {
  readonly size = 1;
  constructor(private readonly runner: AttemptRunner) {}
  async run(job: Job) { return this.runner.run(job); }
  async close() {}
}

/** One worker thread per slot, each with its own copy of the brain (~0.5 GB). */
export class WorkerComputer implements Computer {
  private readonly idle: Worker[] = [];
  private readonly waiting: ((w: Worker) => void)[] = [];
  private readonly all: Worker[] = [];
  private readonly pending = new Map<number, { resolve: (r: AttemptResult) => void; reject: (e: Error) => void }>();

  constructor(readonly size: number, brainDir: string, readout: Readout) {
    for (let i = 0; i < size; i++) {
      // tsx's loader comes along through execArgv, so the worker can be TypeScript too
      const w = new Worker(new URL('./attemptWorker.ts', import.meta.url), { workerData: { brainDir, readout } });
      w.on('message', (r: AttemptResult) => {
        const p = this.pending.get(r.id);
        this.pending.delete(r.id);
        this.release(w);
        p?.resolve(r);
      });
      w.on('error', (e) => { for (const p of this.pending.values()) p.reject(e); this.pending.clear(); });
      this.all.push(w);
      this.idle.push(w);
    }
  }

  static defaultSize() { return Math.max(1, cpus().length - 1); }

  run(job: Job) {
    return new Promise<AttemptResult>((resolve, reject) => {
      const go = (w: Worker) => { this.pending.set(job.id, { resolve, reject }); w.postMessage(job); };
      const w = this.idle.pop();
      if (w) go(w); else this.waiting.push(go);
    });
  }

  private release(w: Worker) {
    const next = this.waiting.shift();
    if (next) next(w); else this.idle.push(w);
  }

  async close() { await Promise.all(this.all.map((w) => w.terminate())); }
}
