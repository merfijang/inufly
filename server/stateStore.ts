import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Load JSON state; a missing file gives `fresh()`, an unreadable one is kept as `.bak`. */
export function loadState<T extends { version: number }>(path: string, fresh: () => T): T {
  if (!existsSync(path)) return fresh();
  const text = readFileSync(path, 'utf8');
  try {
    const parsed = JSON.parse(text) as T;
    if (parsed?.version === fresh().version) return parsed;
  } catch { /* fall through */ }
  writeFileSync(`${path}.bak`, text);
  return fresh();
}

/** Write via a temp file and rename so a crash never leaves half a state file. */
export function saveState(path: string, state: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(state));
  renameSync(`${path}.tmp`, path);
}
