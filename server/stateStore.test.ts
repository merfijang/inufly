import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadState, saveState } from './stateStore';

interface S { version: 1; n: number; list: number[] }
const fresh = (): S => ({ version: 1, n: 0, list: [] });
const dir = () => mkdtempSync(join(tmpdir(), 'flappyfly-'));

describe('stateStore', () => {
  it('returns fresh state when no file exists', () => {
    expect(loadState(join(dir(), 'state.json'), fresh)).toEqual(fresh());
  });
  it('round-trips saved state', () => {
    const path = join(dir(), 'state.json');
    saveState(path, { version: 1, n: 7, list: [1, 2] });
    expect(loadState(path, fresh)).toEqual({ version: 1, n: 7, list: [1, 2] });
  });
  it('writes atomically without leaving a temp file behind', () => {
    const path = join(dir(), 'state.json');
    saveState(path, fresh());
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
  it('keeps a corrupt file as .bak and starts fresh', () => {
    const path = join(dir(), 'state.json');
    writeFileSync(path, '{not json');
    expect(loadState(path, fresh)).toEqual(fresh());
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe('{not json');
  });
  it('treats an unknown version as corrupt', () => {
    const path = join(dir(), 'state.json');
    writeFileSync(path, JSON.stringify({ version: 99 }));
    expect(loadState(path, fresh)).toEqual(fresh());
    expect(existsSync(`${path}.bak`)).toBe(true);
  });
});
