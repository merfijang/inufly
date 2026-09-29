import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Connectome, parseMeta, parseWeights } from '../src/core/connectome';

/** Parts are byte slices of one (optionally gzipped) stream, as in the browser worker. */
function readParts(paths: string[]) {
  const raw = Buffer.concat(paths.map((p) => readFileSync(p)));
  const bytes = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function loadMeta(dir = join(process.cwd(), 'brain')) {
  return parseMeta(readParts([join(dir, 'meta.bin')]));
}

/** Load the exported MaleCNS files from `dir` (public/brain by default). */
export function loadBrain(dir = join(process.cwd(), 'brain'), seed = 1) {
  const manifest = JSON.parse(readFileSync(join(dir, 'brain.json'), 'utf8')) as { parts: string[]; connections: number };
  const weights = parseWeights(readParts(manifest.parts.map((p) => join(dir, p))));
  if (weights.nnz !== manifest.connections) throw new Error(`expected ${manifest.connections} connections, got ${weights.nnz}`);
  return new Connectome(loadMeta(dir), weights, seed);
}
