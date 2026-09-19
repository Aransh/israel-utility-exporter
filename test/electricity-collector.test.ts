import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ElectricityConfig } from '../src/config.js';
import { ElectricityCollector } from '../src/electricity/collector.js';
import { ReadingResolution } from '../src/electricity/iec-client.js';
import type { Logger } from '../src/logger.js';
import { registry } from '../src/metrics.js';
import { dateToEpochSeconds, monthAbbreviation, shiftDays } from '../src/time/day.js';

const VALID_ID = '000000000';
const CONTRACT_ID = '900123456';
const METER_SERIAL = '12345678';
const METER_CODE = 'AB1';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function fakeIdToken(expiresInSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function fakeIec() {
  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    if (u.hostname !== 'iecapi.iec.co.il') {
      return new Response('', { status: 404 });
    }
    if (u.pathname === '/api/customer') {
      return json({ bpNumber: 'BP1' });
    }
    if (u.pathname === '/api/customer/contract/BP1') {
      return json({ contracts: [{ contractId: CONTRACT_ID }] });
    }
    if (u.pathname === `/api/Device/${CONTRACT_ID}`) {
      return json([{ deviceNumber: METER_SERIAL, deviceCode: METER_CODE }]);
    }
    if (u.pathname === `/api/Consumption/RemoteReadingRange/${CONTRACT_ID}`) {
      const body = JSON.parse(init.body as string) as { resolution: number };
      return body.resolution === 1
        ? json({ meterList: [{ periodConsumptions: [{ interval: '2026-08-19T00:00:00+00:00', consumption: 5 }] }] })
        : json({ meterList: [{ totalConsumptionForPeriod: 10 }] });
    }
    return new Response('', { status: 404 });
  };
}

function captureLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const capture = (msg: string) => lines.push(msg);
  return { log: { debug: capture, info: capture, warn: capture, error: capture }, lines };
}

function makeConfig(tokenFile: string): ElectricityConfig {
  return { israeliId: VALID_ID, tokenFile, pollIntervalMs: 3_600_000, tariffMode: 'flat', pricePerKwh: null, tariffScheduleFile: null, vatPercent: 0 };
}

/** Like `fakeIec`, but the MONTHLY call also carries a real day-by-day breakdown, for pricing the month-to-date cost. */
function fakeIecWithMonthlyBreakdown(dailyByLocalDate: Record<string, number>) {
  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    if (u.hostname !== 'iecapi.iec.co.il') {
      return new Response('', { status: 404 });
    }
    if (u.pathname === '/api/customer') {
      return json({ bpNumber: 'BP1' });
    }
    if (u.pathname === '/api/customer/contract/BP1') {
      return json({ contracts: [{ contractId: CONTRACT_ID }] });
    }
    if (u.pathname === `/api/Device/${CONTRACT_ID}`) {
      return json([{ deviceNumber: METER_SERIAL, deviceCode: METER_CODE }]);
    }
    if (u.pathname === `/api/Consumption/RemoteReadingRange/${CONTRACT_ID}`) {
      const body = JSON.parse(init.body as string) as { resolution: number };
      const total = Object.values(dailyByLocalDate).reduce((sum, v) => sum + v, 0);
      if (body.resolution !== ReadingResolution.MONTHLY) {
        return json({ meterList: [{ periodConsumptions: [{ interval: '2026-08-19T00:00:00+00:00', consumption: 5 }] }] });
      }
      return json({
        meterList: [
          {
            totalConsumptionForPeriod: total,
            periodConsumptions: Object.entries(dailyByLocalDate).map(([localDate, consumption]) => ({
              interval: new Date(dateToEpochSeconds(localDate) * 1000).toISOString(),
              consumption,
            })),
          },
        ],
      });
    }
    return new Response('', { status: 404 });
  };
}

test('logs the backfill hint on a genuine first run, and not again once data has been recorded', async () => {
  globalThis.fetch = fakeIec() as typeof fetch;

  const dataDir = mkdtempSync(join(tmpdir(), 'electricity-collector-'));
  const tokenFile = join(dataDir, 'iec-token.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );

  const first = captureLog();
  const collectorA = new ElectricityCollector(makeConfig(tokenFile), dataDir, first.log);
  await collectorA.start();
  collectorA.stop();
  assert.ok(first.lines.some((line) => line.includes('First run detected')), 'must log the hint on a genuine first run');

  const second = captureLog();
  const collectorB = new ElectricityCollector(makeConfig(tokenFile), dataDir, second.log);
  await collectorB.start();
  collectorB.stop();
  assert.ok(!second.lines.some((line) => line.includes('First run detected')), 'must not log the hint again once data has been recorded');
});

test('keeps showing the hint across restarts if no poll has ever succeeded', async () => {
  globalThis.fetch = (async () => new Response('', { status: 500 })) as typeof fetch;

  const dataDir = mkdtempSync(join(tmpdir(), 'electricity-collector-'));
  const tokenFile = join(dataDir, 'iec-token.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );

  const first = captureLog();
  const collectorA = new ElectricityCollector(makeConfig(tokenFile), dataDir, first.log);
  await collectorA.start();
  collectorA.stop();
  assert.ok(first.lines.some((line) => line.includes('First run detected')));

  const second = captureLog();
  const collectorB = new ElectricityCollector(makeConfig(tokenFile), dataDir, second.log);
  await collectorB.start();
  collectorB.stop();
  assert.ok(second.lines.some((line) => line.includes('First run detected')), 'must still show the hint since no poll has ever succeeded');
});

test('flat tariff mode sets the month-to-date cost gauge from each published day, not just the newest one', async () => {
  globalThis.fetch = fakeIecWithMonthlyBreakdown({ '2026-01-01': 1, '2026-01-02': 2, '2026-01-03': 3 }) as typeof fetch;

  const dataDir = mkdtempSync(join(tmpdir(), 'electricity-collector-'));
  const tokenFile = join(dataDir, 'iec-token.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );
  const config: ElectricityConfig = { ...makeConfig(tokenFile), pricePerKwh: 2 };
  const collector = new ElectricityCollector(config, dataDir, captureLog().log);
  await collector.start();
  collector.stop();

  // (1 + 2 + 3) kWh across the month, each day @ 2 ILS/kWh = 12.
  const body = await registry.metrics();
  assert.match(body, new RegExp(`israel_utility_electricity_cost_estimate_monthly_ils\\{contract_id="${CONTRACT_ID}"\\} 12`));
});

test('prices last calendar month\'s total separately from this month\'s, with the same tariff', async () => {
  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    if (u.hostname !== 'iecapi.iec.co.il') {
      return new Response('', { status: 404 });
    }
    if (u.pathname === '/api/customer') {
      return json({ bpNumber: 'BP1' });
    }
    if (u.pathname === '/api/customer/contract/BP1') {
      return json({ contracts: [{ contractId: CONTRACT_ID }] });
    }
    if (u.pathname === `/api/Device/${CONTRACT_ID}`) {
      return json([{ deviceNumber: METER_SERIAL, deviceCode: METER_CODE }]);
    }
    if (u.pathname === `/api/Consumption/RemoteReadingRange/${CONTRACT_ID}`) {
      const body = JSON.parse(init.body as string) as { resolution: number; fromDate: string };
      if (body.resolution !== ReadingResolution.MONTHLY) {
        return json({ meterList: [{ periodConsumptions: [] }] });
      }
      const dailyByLocalDate = body.fromDate.slice(0, 7) === currentMonthKey ? { [body.fromDate]: 5 } : { [body.fromDate]: 8 };
      const total = Object.values(dailyByLocalDate).reduce((sum, v) => sum + v, 0);
      return json({
        meterList: [
          {
            totalConsumptionForPeriod: total,
            periodConsumptions: Object.entries(dailyByLocalDate).map(([localDate, consumption]) => ({
              interval: new Date(dateToEpochSeconds(localDate) * 1000).toISOString(),
              consumption,
            })),
          },
        ],
      });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;

  const dataDir = mkdtempSync(join(tmpdir(), 'electricity-collector-'));
  const tokenFile = join(dataDir, 'iec-token.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );
  const config: ElectricityConfig = { ...makeConfig(tokenFile), pricePerKwh: 2 };
  const collector = new ElectricityCollector(config, dataDir, captureLog().log);
  await collector.start();
  collector.stop();

  // this month: 5 kWh @ 2 = 10; last month: 8 kWh @ 2 = 16.
  const previousMonth = monthAbbreviation(shiftDays(`${currentMonthKey}-01`, -1));
  const body = await registry.metrics();
  assert.match(body, new RegExp(`israel_utility_electricity_cost_estimate_monthly_ils\\{contract_id="${CONTRACT_ID}"\\} 10`));
  assert.match(
    body,
    new RegExp(`israel_utility_electricity_cost_estimate_previous_month_ils\\{contract_id="${CONTRACT_ID}",month="${previousMonth}"\\} 16`),
  );
});

test('does not set the previous-month cost gauge at all when last month has no published data, rather than a misleading ₪0', async () => {
  globalThis.fetch = (async (url: string) => {
    const u = new URL(url);
    if (u.hostname !== 'iecapi.iec.co.il') {
      return new Response('', { status: 404 });
    }
    if (u.pathname === '/api/customer') {
      return json({ bpNumber: 'BP1' });
    }
    if (u.pathname === '/api/customer/contract/BP1') {
      return json({ contracts: [{ contractId: CONTRACT_ID }] });
    }
    if (u.pathname === `/api/Device/${CONTRACT_ID}`) {
      return json([{ deviceNumber: METER_SERIAL, deviceCode: METER_CODE }]);
    }
    if (u.pathname === `/api/Consumption/RemoteReadingRange/${CONTRACT_ID}`) {
      // Every MONTHLY call, including the previous-month one, reports no
      // periods at all — as IEC would for an account that didn't exist yet.
      return json({ meterList: [{ totalConsumptionForPeriod: 0, periodConsumptions: [] }] });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;

  const dataDir = mkdtempSync(join(tmpdir(), 'electricity-collector-'));
  const tokenFile = join(dataDir, 'iec-token.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );
  const config: ElectricityConfig = { ...makeConfig(tokenFile), pricePerKwh: 2 };
  const collector = new ElectricityCollector(config, dataDir, captureLog().log);
  await collector.start();
  collector.stop();

  const body = await registry.metrics();
  // The metric's HELP/TYPE header lines are always present (prom-client
  // emits those for every registered gauge regardless of whether any series
  // was ever set) — only a `metric{...} value` data line would mean the
  // gauge actually got set, which must not happen here.
  assert.doesNotMatch(
    body,
    /israel_utility_electricity_cost_estimate_previous_month_ils\{/,
    '`electricityMonthlyCostEstimate` returns 0, not null, for an empty day list when pricing is configured — this must be guarded explicitly, not just checked for null',
  );
});

test('prunes the previous month gauge\'s stale month label once the calendar month rolls over, instead of leaving it stuck forever', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 1, 15).getTime() }); // Feb 15, 2026 -> "previous month" is January

  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    if (u.hostname !== 'iecapi.iec.co.il') {
      return new Response('', { status: 404 });
    }
    if (u.pathname === '/api/customer') {
      return json({ bpNumber: 'BP1' });
    }
    if (u.pathname === '/api/customer/contract/BP1') {
      return json({ contracts: [{ contractId: CONTRACT_ID }] });
    }
    if (u.pathname === `/api/Device/${CONTRACT_ID}`) {
      return json([{ deviceNumber: METER_SERIAL, deviceCode: METER_CODE }]);
    }
    if (u.pathname === `/api/Consumption/RemoteReadingRange/${CONTRACT_ID}`) {
      const body = JSON.parse(init.body as string) as { resolution: number; fromDate: string };
      if (body.resolution !== ReadingResolution.MONTHLY) {
        return json({ meterList: [{ periodConsumptions: [] }] });
      }
      return json({
        meterList: [
          {
            totalConsumptionForPeriod: 1,
            periodConsumptions: [{ interval: new Date(dateToEpochSeconds(body.fromDate) * 1000).toISOString(), consumption: 1 }],
          },
        ],
      });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;

  const firstPollDataDir = mkdtempSync(join(tmpdir(), 'electricity-collector-'));
  const firstPollTokenFile = join(firstPollDataDir, 'iec-token.json');
  writeFileSync(
    firstPollTokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );
  const config: ElectricityConfig = { ...makeConfig(firstPollTokenFile), pricePerKwh: 2 };
  const firstCollector = new ElectricityCollector(config, firstPollDataDir, captureLog().log);
  await firstCollector.start();
  firstCollector.stop();

  let body = await registry.metrics();
  assert.match(body, new RegExp(`israel_utility_electricity_cost_estimate_previous_month_ils\\{contract_id="${CONTRACT_ID}",month="Jan"\\}`));

  // A month passes; the live collector polls again (a fresh instance here,
  // same as a real one would after this process's own state file already
  // has `hasRecordedData` — the label pruning below happens in `record()`
  // regardless of which collector instance calls it, since the underlying
  // Gauge is a shared module-level registry).
  t.mock.timers.setTime(new Date(2026, 2, 15).getTime()); // March 15, 2026 -> "previous month" is now February

  const secondPollDataDir = mkdtempSync(join(tmpdir(), 'electricity-collector-'));
  const secondPollTokenFile = join(secondPollDataDir, 'iec-token.json');
  writeFileSync(
    secondPollTokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );
  const secondCollector = new ElectricityCollector({ ...config, tokenFile: secondPollTokenFile }, secondPollDataDir, captureLog().log);
  await secondCollector.start();
  secondCollector.stop();

  body = await registry.metrics();
  assert.doesNotMatch(body, /month="Jan"/, 'January\'s entry must be pruned once February becomes "last month" — a Gauge never forgets a label combination on its own');
  assert.match(body, new RegExp(`israel_utility_electricity_cost_estimate_previous_month_ils\\{contract_id="${CONTRACT_ID}",month="Feb"\\}`));
});

test('retries persisting the flag on a later successful poll if an earlier write failed', async () => {
  globalThis.fetch = fakeIec() as typeof fetch;

  const workDir = mkdtempSync(join(tmpdir(), 'electricity-collector-'));
  const tokenFile = join(workDir, 'iec-token.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );

  // A plain file where the collector's data directory should be — its
  // internal `mkdir(dirname(statePath), { recursive: true })` fails against
  // this, simulating a transient disk error on the first poll's state write.
  const brokenDataDir = join(workDir, 'not-a-directory');
  writeFileSync(brokenDataDir, 'x');

  const captured = captureLog();
  const config: ElectricityConfig = {
    israeliId: VALID_ID,
    tokenFile,
    pollIntervalMs: 30,
    tariffMode: 'flat',
    pricePerKwh: null,
    tariffScheduleFile: null,
    vatPercent: 0,
  };
  const collector = new ElectricityCollector(config, brokenDataDir, captured.log);

  await collector.start(); // fetches fine, but the state write fails
  assert.ok(captured.lines.some((line) => line.includes('First run detected')));

  // The disk becomes writable again before the next poll.
  unlinkSync(brokenDataDir);
  mkdirSync(brokenDataDir);
  await new Promise((resolve) => setTimeout(resolve, 200)); // let the scheduled next poll run
  collector.stop();

  const persisted = JSON.parse(await readFile(join(brokenDataDir, 'electricity-state.json'), 'utf8')) as { hasRecordedData?: boolean };
  assert.equal(persisted.hasRecordedData, true, 'a later successful poll must retry the write instead of leaving it stuck unpersisted');
});
