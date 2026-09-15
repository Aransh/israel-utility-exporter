import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Reads and JSON-parses a state file, returning null when it does not exist or
 * does not parse — callers treat both as "start fresh" rather than crashing.
 */
export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Writes JSON atomically (temp file + rename) so a crash mid-write can never
 * leave a truncated file that fails to parse on the next start. Mode 0600
 * because these files hold session tokens.
 */
export async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Serialises writes to a single path so two concurrent saves cannot
 * interleave. One queue per path, keyed by the caller.
 */
export function createWriteQueue(): { enqueue: (fn: () => Promise<void>) => void; flush: () => Promise<void> } {
  let queue: Promise<void> = Promise.resolve();
  return {
    enqueue(fn) {
      // Chained regardless of whether the previous write failed: a write
      // failure must not permanently wedge every write after it.
      queue = queue.then(fn, fn);
    },
    flush() {
      return queue;
    },
  };
}
