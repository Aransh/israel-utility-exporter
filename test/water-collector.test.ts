import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { WaterConfig } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import { registry } from '../src/metrics.js';
import { monthAbbreviation, shiftDays } from '../src/time/day.js';
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
    if (path === `/consumption/forecast/${METER_ID}`) {
      return json({ estimatedConsumption: 7 });
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
  return {
    email: 'a@example.com',
    password: 'correct-horse',
    pollIntervalMs: 3_600_000,
    weeklyWindow: 'sunday',
    tariffMode: 'flat',
    pricePerCubicMeter: null,
    tariffTiers: null,
  };
}

test('tiered tariff mode sets the threshold, effective rate, and cost gauges from the month-to-date consumption', async () => {
  globalThis.fetch = fakePortal() as typeof fetch;
  const dataDir = mkdtempSync(join(tmpdir(), 'water-collector-'));

  const config: WaterConfig = {
    ...makeConfig(),
    tariffMode: 'tiered',
    tariffTiers: { normalRatePerCubicMeter: 2, excessRatePerCubicMeter: 9, householdSize: 2, allowancePerPersonCubicMeters: 1.5 },
  };
  const collector = new WaterCollector(config, dataDir, captureLog().log);
  await collector.start();
  collector.stop();

  // monthly consumption is 5 m3, forecast is 7 m3 (fakePortal); threshold is
  // 2 * 1.5 = 3 m3; monthly cost is 3 m3 @ 2 + 2 m3 @ 9 = 24, effective rate
  // is 24 / 5 = 4.8; forecast cost is 3 m3 @ 2 + 4 m3 @ 9 = 42.
  const LABELS = 'meter_id="55123",meter_serial="SER1"';
  const body = await registry.metrics();
  assert.match(body, new RegExp(`israel_utility_water_tariff_threshold_cubic_meters\\{${LABELS}\\} 3`));
  assert.match(body, new RegExp(`israel_utility_water_effective_rate_ils_per_cubic_meter\\{${LABELS}\\} 4\\.8`));
  assert.match(body, new RegExp(`israel_utility_water_tariff_normal_rate_ils_per_cubic_meter\\{${LABELS}\\} 2`));
  assert.match(body, new RegExp(`israel_utility_water_cost_estimate_ils\\{${LABELS}\\} 24`));
  assert.match(body, new RegExp(`israel_utility_water_cost_estimate_forecast_ils\\{${LABELS}\\} 42`));
});

test('flat tariff mode also prices the forecast, the same way as the month-to-date estimate', async () => {
  globalThis.fetch = fakePortal() as typeof fetch;
  const dataDir = mkdtempSync(join(tmpdir(), 'water-collector-'));

  const config: WaterConfig = { ...makeConfig(), pricePerCubicMeter: 3 };
  const collector = new WaterCollector(config, dataDir, captureLog().log);
  await collector.start();
  collector.stop();

  // monthly 5 m3 @ 3 = 15; forecast 7 m3 @ 3 = 21.
  const LABELS = 'meter_id="55123",meter_serial="SER1"';
  const body = await registry.metrics();
  assert.match(body, new RegExp(`israel_utility_water_cost_estimate_ils\\{${LABELS}\\} 15`));
  assert.match(body, new RegExp(`israel_utility_water_cost_estimate_forecast_ils\\{${LABELS}\\} 21`));
});

test('prices last calendar month\'s total separately from this month\'s, with the same tariff', async () => {
  const today = new Date();
  const currentMonthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
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
      return json([]);
    }
    if (path.startsWith(`/consumption/monthly/${METER_ID}/`)) {
      const requestedDate = path.split('/')[4]!;
      const cons = requestedDate.slice(0, 7) === currentMonthKey ? 5 : 8;
      return json([{ meterCount: METER_ID, consDate: `${requestedDate}T00:00:00`, cons }]);
    }
    if (path === `/consumption/forecast/${METER_ID}`) {
      return json({ estimatedConsumption: null });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;

  const dataDir = mkdtempSync(join(tmpdir(), 'water-collector-'));
  const config: WaterConfig = { ...makeConfig(), pricePerCubicMeter: 3 };
  const collector = new WaterCollector(config, dataDir, captureLog().log);
  await collector.start();
  collector.stop();

  // this month: 5 m3 @ 3 = 15; last month: 8 m3 @ 3 = 24.
  const LABELS = 'meter_id="55123",meter_serial="SER1"';
  const previousMonth = monthAbbreviation(shiftDays(`${currentMonthKey}-01`, -1));
  const body = await registry.metrics();
  assert.match(body, new RegExp(`israel_utility_water_cost_estimate_ils\\{${LABELS}\\} 15`));
  assert.match(
    body,
    new RegExp(`israel_utility_water_cost_estimate_previous_month_ils\\{${LABELS},month="${previousMonth}"\\} 24`),
  );
});

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

test('retries persisting the flag on a later successful poll if an earlier write failed', async () => {
  globalThis.fetch = fakePortal() as typeof fetch;

  const workDir = mkdtempSync(join(tmpdir(), 'water-collector-'));
  // A plain file where the collector's data directory should be — its
  // internal `mkdir(dirname(statePath), { recursive: true })` fails against
  // this, simulating a transient disk error on the first poll's state write.
  const brokenDataDir = join(workDir, 'not-a-directory');
  writeFileSync(brokenDataDir, 'x');

  const captured = captureLog();
  const collector = new WaterCollector({ ...makeConfig(), pollIntervalMs: 30 }, brokenDataDir, captured.log);

  await collector.start(); // fetches fine, but every state write fails (including the initial device-id write)
  assert.ok(captured.lines.some((line) => line.includes('First run detected')));

  // The disk becomes writable again before the next poll.
  unlinkSync(brokenDataDir);
  mkdirSync(brokenDataDir);
  // The water client paces its requests 250ms apart, and a poll makes
  // several of them — give the scheduled next poll enough real time to
  // actually finish, not just start.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  collector.stop();

  const persisted = JSON.parse(await readFile(join(brokenDataDir, 'water-state.json'), 'utf8')) as { hasRecordedData?: boolean };
  assert.equal(persisted.hasRecordedData, true, 'a later successful poll must retry the write instead of leaving it stuck unpersisted');
});
