import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createWriteQueue, readJsonFile, writeJsonFileAtomic } from '../src/state/atomic-file.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'atomic-file-'));
}

test('readJsonFile returns null for a file that does not exist', async () => {
  const path = join(tempDir(), 'missing.json');
  assert.equal(await readJsonFile(path), null);
});

test('readJsonFile returns null for malformed JSON, rather than throwing', async () => {
  const path = join(tempDir(), 'broken.json');
  writeFileSync(path, '{ not valid json');
  assert.equal(await readJsonFile(path), null);
});

test('writeJsonFileAtomic writes a file readJsonFile can read back', async () => {
  const path = join(tempDir(), 'state.json');
  await writeJsonFileAtomic(path, { hello: 'world', n: 3 });
  assert.deepEqual(await readJsonFile(path), { hello: 'world', n: 3 });
});

test('writeJsonFileAtomic creates the destination directory if it does not exist yet', async () => {
  const path = join(tempDir(), 'nested', 'dir', 'state.json');
  await writeJsonFileAtomic(path, { ok: true });
  assert.deepEqual(await readJsonFile(path), { ok: true });
});

test('writeJsonFileAtomic writes the file with mode 0600', async () => {
  const path = join(tempDir(), 'state.json');
  await writeJsonFileAtomic(path, { token: 'secret' });
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('writeJsonFileAtomic leaves no temp file behind on success', async () => {
  const dir = tempDir();
  const path = join(dir, 'state.json');
  await writeJsonFileAtomic(path, { ok: true });
  assert.deepEqual(readdirSync(dir), ['state.json']);
});

test('a value that cannot be serialised leaves an existing destination file untouched and no temp file behind', async () => {
  const dir = tempDir();
  const path = join(dir, 'state.json');
  await writeJsonFileAtomic(path, { good: 'data' });

  // A BigInt makes JSON.stringify throw — this must fail before ever
  // touching the destination file, the same guarantee a crash mid-write
  // (interrupting the temp file, before the rename) is meant to provide.
  await assert.rejects(() => writeJsonFileAtomic(path, { bad: 1n as unknown as number }));

  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { good: 'data' });
  assert.deepEqual(readdirSync(dir), ['state.json'], 'no leftover .tmp file');
});

test('createWriteQueue runs enqueued writes in order, one at a time', async () => {
  const queue = createWriteQueue();
  const order: number[] = [];
  queue.enqueue(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push(1);
  });
  queue.enqueue(async () => {
    order.push(2);
  });
  await queue.flush();
  assert.deepEqual(order, [1, 2]);
});

test('createWriteQueue keeps running later writes after an earlier one fails', async () => {
  const queue = createWriteQueue();
  const ran: string[] = [];
  queue.enqueue(async () => {
    ran.push('first');
    throw new Error('disk full');
  });
  queue.enqueue(async () => {
    ran.push('second');
  });
  // flush() surfaces the most recently settled write's own outcome — the
  // second write's success — not the first write's failure, since the
  // chain must not stay permanently rejected after one bad write.
  await queue.flush();
  assert.deepEqual(ran, ['first', 'second']);
});

test('createWriteQueue.flush rejects if the most recently enqueued write is still failing', async () => {
  const queue = createWriteQueue();
  queue.enqueue(async () => {
    throw new Error('nope');
  });
  await assert.rejects(() => queue.flush(), /nope/);
});
