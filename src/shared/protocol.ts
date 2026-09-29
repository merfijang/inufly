// Server → site messages. JSON for everything except neural activity, which is a binary
// bitset over the display neurons (see display.ts), sent 10 times a second.
import type { Course } from '../game/runner';

export interface AttemptRecord { n: number; generation: number; metres: number; seconds: number; cause: string; at: number }

export interface Stats {
  attempts: number; generation: number; queue: number; bestMetres: number;
  totalFeeLamports: number; pendingLamports: number; lamportsPerAttempt: number;
  feeSource: 'mock' | 'solana'; feeWallets: string[]; running: boolean;
}

/** The site rebuilds the course from `seed` and `course` with the same generator the server runs. */
export interface AttemptStart { type: 'attempt_start'; n: number; generation: number; sample: number; pop: number; seed: number; course: Course }

/** One 20 ms step of the dog. `a`: the action the fly took this step, if any. `p`: left, right, jump, roll. `c`: rolling. */
export interface Frame { type: 'frame'; t: number; z: number; x: number; y: number; a?: 'left' | 'right' | 'jump' | 'roll'; c?: 1; p: number[] }

export type ServerMessage =
  | { type: 'hello'; stats: Stats; history: AttemptRecord[]; current: AttemptStart | null; displayCount: number; readoutGroups: string[] }
  | Frame
  | AttemptStart
  | { type: 'attempt_end'; record: AttemptRecord }
  | { type: 'fee'; lamports: number; signature: string; attemptsAdded: number }
  | { type: 'stats'; stats: Stats };

/** Pack one byte-per-neuron hit flags into a bitset. */
export function encodeBits(hits: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(hits.length / 8));
  for (let i = 0; i < hits.length; i++) if (hits[i]) out[i >> 3] |= 1 << (i & 7);
  return out;
}

export function decodeBits(bytes: Uint8Array, count: number, out = new Uint8Array(count)): Uint8Array {
  for (let i = 0; i < count; i++) out[i] = (bytes[i >> 3] >> (i & 7)) & 1;
  return out;
}
