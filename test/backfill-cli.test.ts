import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { chunk, collectElectricity, collectWater, parseArgs, resolveRange } from '../src/backfill-cli.js';
import type { ElectricityConfig, WaterConfig } from '../src/config.js';
import { ReadingResolution } from '../src/electricity/iec-client.js';
import type { Logger } from '../src/logger.js';
import { dateToEpochSeconds, isoDate, shiftDays } from '../src/time/day.js';

const SILENT_LOG: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('parseArgs defaults --service to "all" and accepts --from/--to', () => {
  const args = parseArgs(['--from', '2026-01-01', '--to', '2026-02-01']);
  assert.equal(args.service, 'all');
  assert.equal(args.from, '2026-01-01');
  assert.equal(args.to, '2026-02-01');
  assert.equal(args.dryRun, false);
});

test('parseArgs accepts --service, --days and --dry-run', () => {
  const args = parseArgs(['--service', 'water', '--days', '30', '--dry-run']);
  assert.equal(args.service, 'water');
  assert.equal(args.days, 30);
  assert.equal(args.dryRun, true);
});

test('parseArgs rejects an invalid --service value', () => {
  assert.throws(() => parseArgs(['--service', 'gas', '--days', '1']), /--service must be/);
});

test('parseArgs rejects combining --days with --from/--to', () => {
  assert.throws(() => parseArgs(['--days', '1', '--from', '2026-01-01', '--to', '2026-01-02']), /cannot be combined/);
});

test('parseArgs rejects no range at all', () => {
  assert.throws(() => parseArgs(['--service', 'all']), /Specify either/);
});

test('parseArgs rejects a non-positive --days', () => {
  assert.throws(() => parseArgs(['--days', '0']), /positive integer/);
});

test('parseArgs rejects a fractional --days', () => {
  assert.throws(() => parseArgs(['--days', '2.5']), /positive integer/);
});

test('parseArgs rejects an unrecognized argument instead of silently ignoring it', () => {
  assert.throws(() => parseArgs(['--servcie', 'electricity', '--days', '90']), /Unrecognized argument/);
});

test('parseArgs rejects a flag missing its value instead of silently ignoring it', () => {
  assert.throws(() => parseArgs(['--service']), /--service requires a value/);
  assert.throws(() => parseArgs(['--days', '30', '--from']), /--from requires a value/);
});

test('resolveRange passes through an explicit --from/--to', () => {
  assert.deepEqual(resolveRange({ service: 'all', from: '2026-01-01', to: '2026-01-31', dryRun: false }), {
    from: '2026-01-01',
    to: '2026-01-31',
  });
});

test('resolveRange rejects --from after --to', () => {
  assert.throws(() => resolveRange({ service: 'all', from: '2026-02-01', to: '2026-01-01', dryRun: false }), /must not be after/);
});

test('resolveRange rejects a malformed date', () => {
  assert.throws(() => resolveRange({ service: 'all', from: '2026/01/01', to: '2026-01-31', dryRun: false }), /YYYY-MM-DD/);
});

test('resolveRange rejects a calendar date that does not exist', () => {
  assert.throws(() => resolveRange({ service: 'all', from: '2026-02-31', to: '2026-03-01', dryRun: false }), /real calendar dates/);
});

test('resolveRange turns --days into an inclusive range of exactly N calendar days ending today', () => {
  const range = resolveRange({ service: 'all', days: 10, dryRun: false });
  assert.equal(range.to, isoDate(new Date()));
  assert.equal(range.from, shiftDays(range.to, -9), '--days 10 must span exactly 10 calendar dates, not 11');
});

test('resolveRange --days 1 backfills only today, not today and yesterday', () => {
  const range = resolveRange({ service: 'all', days: 1, dryRun: false });
  assert.equal(range.from, range.to);
  assert.equal(range.to, isoDate(new Date()));
});

test('chunk splits an array into groups of the given size, including a short last group', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
  assert.deepEqual(chunk([1], 5), [[1]]);
});

const METER_COUNT = 777;

function fakeWaterPortal() {
  return async (url: string): Promise<Response> => {
    const path = new URL(url).pathname;
    if (path === '/consumer/login') {
      return json({ token: 'tok' });
    }
    if (path === '/consumption/last-read') {
      return json([{ meterCount: METER_COUNT, meterId: 'SER1', read: 100 }]);
    }
    if (path.startsWith(`/consumption/daily/${METER_COUNT}/`)) {
      const [from, to] = path.split('/').slice(-2) as [string, string];
      const rows: unknown[] = [];
      for (let date = from; date <= to; date = shiftDays(date, 1)) {
        rows.push({ meterCount: METER_COUNT, consDate: `${date}T00:00:00`, cons: 1 });
      }
      return json(rows);
    }
    if (path.startsWith(`/consumption/monthly/${METER_COUNT}/`)) {
      return json([{ meterCount: METER_COUNT, consDate: '2026-01-01T00:00:00', cons: 30 }]);
    }
    return new Response('', { status: 404 });
  };
}

test('collectWater skips a fixed weekly bucket that starts before `from` (would otherwise look complete but is missing its leading days)', async () => {
  globalThis.fetch = fakeWaterPortal() as typeof fetch;

  // 2026-01-04, -11 and -18 are Sundays: a `sunday` window snaps `from`
  // (a mid-week Wednesday) back to 2026-01-04, a bucket only fetched
  // starting 2026-01-07 onward — that leading bucket must be skipped.
  const config: WaterConfig = {
    email: 'a@example.com',
    password: 'x',
    pollIntervalMs: 60_000,
    weeklyWindow: 'sunday',
    tariffMode: 'flat',
    pricePerCubicMeter: null,
    tariffTiers: null,
  };
  const points = await collectWater(config, '2026-01-07', '2026-01-24', SILENT_LOG);

  const weeklyPoints = points.filter((p) => p.metric === 'israel_utility_water_consumption_weekly_liters');
  assert.equal(weeklyPoints.length, 2, 'the partial leading week must be skipped, leaving only the 2 fully-covered weeks');

  const timestamps = weeklyPoints.map((p) => p.timestampMs).sort((a, b) => a - b);
  assert.deepEqual(timestamps, [dateToEpochSeconds('2026-01-17') * 1000, dateToEpochSeconds('2026-01-24') * 1000]);
});

test('collectWater includes a rolling weekly bucket that starts exactly at `from`', async () => {
  globalThis.fetch = fakeWaterPortal() as typeof fetch;

  const config: WaterConfig = {
    email: 'a@example.com',
    password: 'x',
    pollIntervalMs: 60_000,
    weeklyWindow: 'rolling',
    tariffMode: 'flat',
    pricePerCubicMeter: null,
    tariffTiers: null,
  };
  const points = await collectWater(config, '2026-01-07', '2026-01-20', SILENT_LOG);

  const weeklyPoints = points.filter((p) => p.metric === 'israel_utility_water_consumption_weekly_liters');
  // rolling windows start exactly at `from`, so both 7-day buckets
  // (01-07..01-13 and 01-14..01-20) are fully covered by the fetched range.
  assert.equal(weeklyPoints.length, 2);
});

const VALID_ID = '000000000';
const CONTRACT_ID = '900123456';
const METER_SERIAL = '12345678';
const METER_CODE = 'AB1';

function fakeIdToken(expiresInSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `${header}.${payload}.sig`;
}

/**
 * Reproduces the real IEC behavior confirmed against a live account:
 * MONTHLY resolution returns one period per calendar day within the month
 * (verified to match what a same-day DAILY call reports as its
 * totalForPeriod) alongside the month's own totalForPeriod — so one
 * MONTHLY call per month gives real daily data too, no separate DAILY call
 * needed. `interval` is true UTC; entries near UTC midnight are given in a
 * form that only resolves to the correct local day once parsed as a real
 * instant (not string-sliced).
 */
function fakeIecMonthlyWithDailyBreakdown(dailyByLocalDate: Record<string, number>, monthTotal: number) {
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
      if (body.resolution !== ReadingResolution.MONTHLY) {
        return json({ meterList: [{ totalConsumptionForPeriod: 0 }] });
      }
      return json({
        meterList: [
          {
            totalConsumptionForPeriod: monthTotal,
            // Each entry's `interval` is the true UTC instant of that day's
            // local midnight (computed independently of the test runner's
            // own timezone, via the same local->epoch conversion production
            // code uses) — in any timezone ahead of UTC this lands on the
            // *previous* UTC calendar date, exactly the shape that broke
            // naive `interval.slice(0, 10)`.
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

test('collectElectricity gets real daily data from the MONTHLY call, not a separate DAILY call', async () => {
  globalThis.fetch = fakeIecMonthlyWithDailyBreakdown(
    { '2026-01-01': 1, '2026-01-02': 2, '2026-01-03': 3 },
    6,
  ) as typeof fetch;

  const dataDir = mkdtempSync(join(tmpdir(), 'backfill-electricity-'));
  const tokenFile = join(dataDir, 'iec-token.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );
  const config: ElectricityConfig = { israeliId: VALID_ID, tokenFile, pollIntervalMs: 3_600_000, tariffMode: 'flat', pricePerKwh: null, tariffScheduleFile: null };

  const points = await collectElectricity(config, '2026-01-01', '2026-01-03', SILENT_LOG);

  const dailyPoints = points.filter((p) => p.metric === 'israel_utility_electricity_consumption_daily_kwh');
  const byTimestamp = new Map(dailyPoints.map((p) => [p.timestampMs, p.value]));
  assert.deepEqual(
    byTimestamp,
    new Map([
      [dateToEpochSeconds('2026-01-01') * 1000, 1],
      [dateToEpochSeconds('2026-01-02') * 1000, 2],
      [dateToEpochSeconds('2026-01-03') * 1000, 3],
    ]),
  );

  const monthlyPoints = points.filter((p) => p.metric === 'israel_utility_electricity_consumption_monthly_kwh');
  assert.equal(monthlyPoints.length, 1);
  assert.equal(monthlyPoints[0]!.value, 6);
  assert.equal(monthlyPoints[0]!.timestampMs, dateToEpochSeconds('2026-01-01') * 1000);
});

test('collectElectricity skips a period with an unparseable interval instead of emitting a NaN timestamp', async () => {
  globalThis.fetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
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
      if (body.resolution !== ReadingResolution.MONTHLY) {
        return json({ meterList: [{ totalConsumptionForPeriod: 0 }] });
      }
      return json({
        meterList: [
          {
            totalConsumptionForPeriod: 5,
            periodConsumptions: [
              { interval: 'not-a-real-date', consumption: 999 },
              { interval: new Date(dateToEpochSeconds('2026-01-02') * 1000).toISOString(), consumption: 5 },
            ],
          },
        ],
      });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;

  const dataDir = mkdtempSync(join(tmpdir(), 'backfill-electricity-'));
  const tokenFile = join(dataDir, 'iec-token.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );
  const config: ElectricityConfig = { israeliId: VALID_ID, tokenFile, pollIntervalMs: 3_600_000, tariffMode: 'flat', pricePerKwh: null, tariffScheduleFile: null };

  const points = await collectElectricity(config, '2026-01-01', '2026-01-03', SILENT_LOG);

  const dailyPoints = points.filter((p) => p.metric === 'israel_utility_electricity_consumption_daily_kwh');
  assert.equal(dailyPoints.length, 1, 'the malformed-interval period must be skipped, not turned into a NaN-timestamped sample');
  assert.ok(dailyPoints.every((p) => Number.isFinite(p.timestampMs)));
  assert.equal(dailyPoints[0]!.timestampMs, dateToEpochSeconds('2026-01-02') * 1000);
});
