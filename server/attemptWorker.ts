// A worker thread with its own brain, running the attempts the main thread hands it.
import { parentPort, workerData } from 'node:worker_threads';
import { buildGroups } from '../src/core/sensing';
import type { Readout } from '../src/core/policy';
import { AttemptRunner, type Job } from './attempt';
import { loadBrain } from './brainFiles';

const { brainDir, readout } = workerData as { brainDir: string; readout: Readout };
const brain = loadBrain(brainDir);
const runner = new AttemptRunner(brain, buildGroups(brain.meta), readout);

parentPort!.on('message', (job: Job) => {
  const r = runner.run(job);
  parentPort!.postMessage(r, r.activity.map((b) => b.buffer as ArrayBuffer));
});
