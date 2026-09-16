import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { test } from 'node:test';

import { uncompress } from 'snappyjs';

import { remoteWrite, RemoteWriteError, type RemoteWriteSettings } from '../src/remote-write/client.js';
import type { RwTimeSeries } from '../src/remote-write/protobuf.js';
import { decodeWriteRequest } from './support/protobuf-decode.js';

const SERIES: RwTimeSeries[] = [
  {
    labels: [
      { name: '__name__', value: 'israel_utility_water_consumption_daily_liters' },
      { name: 'meter_id', value: '1' },
    ],
    samples: [{ value: 123, timestampMs: 1_700_000_000_000 }],
  },
];

interface CapturedRequest {
  headers: IncomingMessage['headers'];
  body: Buffer;
}

async function withServer<T>(
  respond: (req: IncomingMessage, captured: CapturedRequest[]) => { status: number; body?: string },
  run: (url: string, captured: CapturedRequest[]) => Promise<T>,
): Promise<T> {
  const captured: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      captured.push({ headers: req.headers, body: Buffer.concat(chunks) });
      const { status, body } = respond(req, captured);
      res.writeHead(status);
      res.end(body ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a network address');
  }
  try {
    return await run(`http://localhost:${address.port}`, captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('sends the correct remote_write headers and a snappy+protobuf body that round-trips', async () => {
  await withServer(
    () => ({ status: 200 }),
    async (url, captured) => {
      const settings: RemoteWriteSettings = { url, timeoutMs: 5000 };
      await remoteWrite(settings, SERIES);

      assert.equal(captured.length, 1);
      const req = captured[0]!;
      assert.equal(req.headers['content-encoding'], 'snappy');
      assert.equal(req.headers['content-type'], 'application/x-protobuf');
      assert.equal(req.headers['x-prometheus-remote-write-version'], '0.1.0');

      const decompressed = Buffer.from(uncompress(req.body));
      const decoded = decodeWriteRequest(decompressed);
      assert.deepEqual(decoded, SERIES);
    },
  );
});

test('sends HTTP Basic auth when username/password are configured', async () => {
  await withServer(
    () => ({ status: 200 }),
    async (url, captured) => {
      await remoteWrite({ url, timeoutMs: 5000, username: 'alice', password: 'secret' }, SERIES);
      const expected = `Basic ${Buffer.from('alice:secret').toString('base64')}`;
      assert.equal(captured[0]!.headers.authorization, expected);
    },
  );
});

test('sends a bearer token when configured', async () => {
  await withServer(
    () => ({ status: 200 }),
    async (url, captured) => {
      await remoteWrite({ url, timeoutMs: 5000, bearerToken: 'tok123' }, SERIES);
      assert.equal(captured[0]!.headers.authorization, 'Bearer tok123');
    },
  );
});

test('retries a 429, then succeeds', async () => {
  let attempts = 0;
  await withServer(
    () => {
      attempts += 1;
      return attempts < 2 ? { status: 429 } : { status: 200 };
    },
    async (url) => {
      await remoteWrite({ url, timeoutMs: 5000, retryBackoffMs: [10, 10, 10] }, SERIES);
      assert.equal(attempts, 2);
    },
  );
});

test('retries a 500, then succeeds', async () => {
  let attempts = 0;
  await withServer(
    () => {
      attempts += 1;
      return attempts < 3 ? { status: 500 } : { status: 200 };
    },
    async (url) => {
      await remoteWrite({ url, timeoutMs: 5000, retryBackoffMs: [10, 10, 10] }, SERIES);
      assert.equal(attempts, 3);
    },
  );
});

test('fails immediately on a plain 400, without retrying', async () => {
  let attempts = 0;
  await withServer(
    () => {
      attempts += 1;
      return { status: 400, body: 'bad request: malformed labels' };
    },
    async (url) => {
      await assert.rejects(() => remoteWrite({ url, timeoutMs: 5000 }, SERIES), RemoteWriteError);
      assert.equal(attempts, 1);
    },
  );
});

test('gives up after exhausting the retry budget on persistent 5xx', async () => {
  let attempts = 0;
  await withServer(
    () => {
      attempts += 1;
      return { status: 503 };
    },
    async (url) => {
      await assert.rejects(() => remoteWrite({ url, timeoutMs: 5000, retryBackoffMs: [10, 10, 10] }, SERIES), RemoteWriteError);
      assert.equal(attempts, 4); // 1 initial + 3 retries
    },
  );
});

test('an empty series list is a no-op and sends nothing', async () => {
  await withServer(
    () => ({ status: 200 }),
    async (url, captured) => {
      await remoteWrite({ url, timeoutMs: 5000 }, []);
      assert.equal(captured.length, 0);
    },
  );
});
