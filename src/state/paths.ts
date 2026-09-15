import { mkdir } from 'node:fs/promises';

/** Resolves and ensures the directory used to persist session/token state. */
export async function resolveDataDir(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  return dataDir;
}
