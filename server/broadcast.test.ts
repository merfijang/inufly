import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildGroups } from '../src/core/sensing';
import { tinyBrain } from '../src/core/testing';
import type { ServerMessage } from '../src/shared/protocol';
import { Broadcaster } from './broadcast';
import { FlyServer, freshState } from './flyServer';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

describe('server over WebSocket', () => {
  it('greets a viewer and streams an attempt, frames and activity', async () => {
    const brain = tinyBrain();
    let fly: FlyServer | undefined;
    const out = new Broadcaster({ hello: () => fly!.hello(), stats: () => fly!.stats() });
    fly = new FlyServer({
      brain, groups: buildGroups(brain.meta), state: freshState({ names: ['DNp01 L'], mean: [0], std: [1], heads: [[0], [0], [0]] }, [0, -20, 0, -20, 0, -20]), capSeconds: 1, pauseTicks: 0,
      lamportsPerAttempt: 100, feeSource: 'mock', feeWallets: [], save: () => undefined, out
    });
    const port = await out.listen(0);
    cleanup = () => out.close();

    expect(await (await fetch(`http://127.0.0.1:${port}/health`)).text()).toBe('ok');
    expect(await (await fetch(`http://127.0.0.1:${port}/stats`)).json()).toMatchObject({ attempts: 0, queue: 0 });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const json: ServerMessage[] = [];
    let binary = 0;
    ws.on('message', (data, isBinary) => { if (isBinary) binary++; else json.push(JSON.parse(String(data))); });
    await new Promise((ok) => ws.on('open', ok));
    await new Promise((ok) => setTimeout(ok, 50));
    expect(json[0]).toMatchObject({ type: 'hello', displayCount: fly.displayCount });

    fly.addFee({ signature: 'x', lamports: 100, slot: 0, blockTime: null });
    while (fly.wantsCompute) fly.computeStep();
    for (let i = 0; i < 200; i++) fly.playTick(false);
    await new Promise((ok) => setTimeout(ok, 100));
    const types = new Set(json.map((m) => m.type));
    for (const t of ['fee', 'stats', 'attempt_start', 'frame', 'attempt_end']) expect(types).toContain(t);
    expect(binary).toBe(10); // 1 s of attempt, activity every 5 steps
    ws.close();
  });
});
