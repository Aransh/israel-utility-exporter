import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { WaterConfig } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import { WaterCollector } from '../src/water/collector.js';

const METER_ID = 55123;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function fakePortal() {
  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    const path = new URL(url).pathname;
    if (path === '/consumer/login') {
      return json({ token: 'tok' });
    }
    const headers = init.headers as Record<string, string> | undefined;
    if (!headers?.['x-access-token']) {
      return new Response('', { status: 401 });
    }
    if (path === '/consumption/last-read') {
      return json([{ meterCount: METER_ID, meterId: 'SER1', read: 100 }]);
    }
    if (path.startsWith(`/consumption/daily/${METER_ID}/`)) {
      return json([{ meterCount: METER_ID, consDate: '2026-08-19T00:00:00', cons: 0.5 }]);
    }
    if (path.startsWith(`/consumption/monthly/${METER_ID}/`)) {
      return json([{ meterCount: METER_ID, consDate: '2026-08-01T00:00:00', cons: 5 }]);
    }
    return new Response('', { status: 404 });
  };
}

function captureLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const capture = (msg: string) => lines.push(msg);
  return { log: { debug: capture, info: capture, warn: capture, error: capture }, lines };
}

function makeConfig(): WaterConfig {
  return { email: 'a@example.com', password: 'correct-horse', pollIntervalMs: 3_600_000, weeklyWindow: 'sunday', pricePerCubicMeter: null };
}

test('logs the backfill hint on a genuine first run, and not again once data has been recorded', async () => {
  globalThis.fetch = fakePortal() as typeof fetch;
  const dataDir = mkdtempSync(join(tmpdir(), 'water-collector-'));

  const first = captureLog();
  const collectorA = new WaterCollector(makeConfig(), dataDir, first.log);
  await collectorA.start();
  collectorA.stop();
  assert.ok(first.lines.some((line) => line.includes('First run detected')), 'must log the hint on a genuine first run');

  const second = captureLog();
  const collectorB = new WaterCollector(makeConfig(), dataDir, second.log);
  await collectorB.start();
  collectorB.stop();
  assert.ok(!second.lines.some((line) => line.includes('First run detected')), 'must not log the hint again once data has been recorded');
});

test('keeps showing the hint across restarts if no poll has ever succeeded', async () => {
  globalThis.fetch = (async () => new Response('', { status: 500 })) as typeof fetch;
  const dataDir = mkdtempSync(join(tmpdir(), 'water-collector-'));

  const first = captureLog();
  const collectorA = new WaterCollector(makeConfig(), dataDir, first.log);
  await collectorA.start();
  collectorA.stop();
  assert.ok(first.lines.some((line) => line.includes('First run detected')));

  const second = captureLog();
  const collectorB = new WaterCollector(makeConfig(), dataDir, second.log);
  await collectorB.start();
  collectorB.stop();
  assert.ok(second.lines.some((line) => line.includes('First run detected')), 'must still show the hint since no poll has ever succeeded');
});
