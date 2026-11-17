import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Answered } from './types.ts';

export const defaultCacheDir = (): string =>
  path.join(process.cwd(), 'node_modules', '.cache', 'oxlint-plugin-jev');

/** One cached answer, or null when the entry is missing or not shaped like one. */
export function readCache(dir: string, key: string): Answered | null {
  try {
    const stored: unknown = JSON.parse(readFileSync(path.join(dir, `${key}.json`), 'utf8'));
    if (typeof stored !== 'object' || stored === null) return null;
    if (!('model' in stored) || typeof stored.model !== 'string' || stored.model === '') {
      return null;
    }
    if (!('answer' in stored)) return null;
    return { model: stored.model, answer: stored.answer };
  } catch {
    return null;
  }
}

export function writeCache(dir: string, key: string, entry: Answered): void {
  const target = path.join(dir, `${key}.json`);
  const temp = `${target}.tmp-${process.pid}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(temp, JSON.stringify(entry));
  renameSync(temp, target);
}
