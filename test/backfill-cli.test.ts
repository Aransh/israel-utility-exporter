import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildEstimatedReadingsPrompt,
  chunk,
  collectElectricity,
  collectWater,
  parseArgs,
  reconstructElectricityMeterReading,
  reconstructMeterReadings,
  resolveIncludeEstimated,
  resolveRange,
} from '../src/backfill-cli.js';
import type { ElectricityConfig, WaterConfig } from '../src/config.js';
import { blendedRateForDay, TariffScheduleError, tieredWaterCost, waterCostEstimate, waterTariffThreshold } from '../src/cost/tariff.js';
import { ReadingResolution } from '../src/electricity/iec-client.js';
import type { Logger } from '../src/logger.js';
import { dateToEpochSeconds, isoDate, parseYmdNoon, shiftDays } from '../src/time/day.js';

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

test('parseArgs leaves includeEstimated undefined (meaning "ask interactively") when neither flag is given', () => {
  assert.equal(parseArgs(['--days', '1']).includeEstimated, undefined);
});

test('parseArgs accepts --estimated-readings', () => {
  assert.equal(parseArgs(['--days', '1', '--estimated-readings']).includeEstimated, true);
});

test('parseArgs accepts --no-estimated-readings', () => {
  assert.equal(parseArgs(['--days', '1', '--no-estimated-readings']).includeEstimated, false);
});

test('parseArgs rejects combining --estimated-readings and --no-estimated-readings', () => {
  assert.throws(() => parseArgs(['--days', '1', '--estimated-readings', '--no-estimated-readings']), /cannot be combined/);
  assert.throws(() => parseArgs(['--days', '1', '--no-estimated-readings', '--estimated-readings']), /cannot be combined/);
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

test('collectWater emits a monthly running total, one point per day, not a single point for the whole month', async () => {
  globalThis.fetch = fakeWaterPortal() as typeof fetch;

  const config: WaterConfig = { email: 'a@example.com', password: 'x', pollIntervalMs: 60_000, weeklyWindow: 'sunday', pricePerCubicMeter: null };
  const points = await collectWater(config, '2026-01-01', '2026-01-03', SILENT_LOG);

  const monthlyPoints = points.filter((p) => p.metric === 'israel_utility_water_consumption_monthly_liters');
  const monthlyByTimestamp = new Map(monthlyPoints.map((p) => [p.timestampMs, p.value]));
  // fakeWaterPortal's daily handler reports 1 m3/day, so liters accumulate 1000, 2000, 3000.
  assert.deepEqual(
    monthlyByTimestamp,
    new Map([
      [dateToEpochSeconds('2026-01-01') * 1000, 1000],
      [dateToEpochSeconds('2026-01-02') * 1000, 2000],
      [dateToEpochSeconds('2026-01-03') * 1000, 3000],
    ]),
  );
});

test('collectWater counts days before `from` toward the monthly running total without writing them as their own daily point', async () => {
  globalThis.fetch = fakeWaterPortal() as typeof fetch;

  const config: WaterConfig = { email: 'a@example.com', password: 'x', pollIntervalMs: 60_000, weeklyWindow: 'sunday', pricePerCubicMeter: null };
  const points = await collectWater(config, '2026-01-03', '2026-01-04', SILENT_LOG);

  const dailyPoints = points.filter((p) => p.metric === 'israel_utility_water_consumption_daily_liters');
  assert.equal(dailyPoints.length, 2, 'only the requested from/to days are written as daily points');

  const monthlyPoints = points.filter((p) => p.metric === 'israel_utility_water_consumption_monthly_liters');
  const monthlyByTimestamp = new Map(monthlyPoints.map((p) => [p.timestampMs, p.value]));
  // Jan 1 and 2 (1 m3 each, before `from`) still count toward the running
  // total even though they aren't themselves written as daily points.
  assert.deepEqual(
    monthlyByTimestamp,
    new Map([
      [dateToEpochSeconds('2026-01-03') * 1000, 3000],
      [dateToEpochSeconds('2026-01-04') * 1000, 4000],
    ]),
  );
});

test('collectWater does not backfill the meter reading unless includeMeterReading is set', async () => {
  globalThis.fetch = fakeWaterPortal() as typeof fetch;
  const config: WaterConfig = { email: 'a@example.com', password: 'x', pollIntervalMs: 60_000, weeklyWindow: 'sunday', pricePerCubicMeter: null };
  const points = await collectWater(config, '2026-01-01', '2026-01-02', SILENT_LOG);
  assert.equal(points.filter((p) => p.metric === 'israel_utility_water_meter_reading_cubic_meters').length, 0);
});

test('collectWater reconstructs the meter reading by walking backward from today when includeMeterReading is set', async () => {
  globalThis.fetch = fakeWaterPortal() as typeof fetch;
  const config: WaterConfig = { email: 'a@example.com', password: 'x', pollIntervalMs: 60_000, weeklyWindow: 'sunday', pricePerCubicMeter: null };
  const to = isoDate(new Date());
  const from = shiftDays(to, -2);

  const points = await collectWater(config, from, to, SILENT_LOG, { includeMeterReading: true });

  const readingPoints = points.filter((p) => p.metric === 'israel_utility_water_meter_reading_cubic_meters');
  // fakeWaterPortal reports the current reading as 100 and 1 m3/day consumption, so walking
  // backward from today: today=100, yesterday=99, the day before=98. Every day here falls
  // within `SPARKLINE_TAIL_DAYS` of today, so each value is written repeatedly through its day
  // rather than as a single point — assert only the value each day's midnight-aligned sample
  // carries, not the exact point count (see the dedicated densification test below for that).
  const valueAtMidnight = (day: string) => readingPoints.find((p) => p.timestampMs === dateToEpochSeconds(day) * 1000)?.value;
  assert.equal(valueAtMidnight(to), 100);
  assert.equal(valueAtMidnight(shiftDays(to, -1)), 99);
  assert.equal(valueAtMidnight(from), 98);
});

test('collectWater writes the meter reading repeatedly through recent days, not just once, so a range-pinned sparkline has samples', async () => {
  globalThis.fetch = fakeWaterPortal() as typeof fetch;
  const config: WaterConfig = { email: 'a@example.com', password: 'x', pollIntervalMs: 60_000, weeklyWindow: 'sunday', pricePerCubicMeter: null };
  const to = isoDate(new Date());
  const from = shiftDays(to, -1);

  const points = await collectWater(config, from, to, SILENT_LOG, { includeMeterReading: true });

  const readingPoints = points.filter((p) => p.metric === 'israel_utility_water_meter_reading_cubic_meters');
  const yesterdayPoints = readingPoints.filter((p) => p.timestampMs >= dateToEpochSeconds(from) * 1000 && p.timestampMs < dateToEpochSeconds(to) * 1000);
  assert.ok(yesterdayPoints.length > 1, 'yesterday is within the densified tail window, so it should carry more than one sample');
  assert.ok(
    yesterdayPoints.every((p) => p.value === 99),
    'every densified sample for the same day repeats that day\'s single known value',
  );
});

test('collectWater writes a same-day point from the live reading even when the portal\'s daily consumption lags several days behind', async () => {
  const to = isoDate(new Date());
  const from = shiftDays(to, -5);
  const publishedThrough = shiftDays(to, -3); // the portal hasn't published the last 3 days yet
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/consumer/login') return json({ token: 'tok' });
    if (path === '/consumption/last-read') return json([{ meterCount: METER_COUNT, meterId: 'SER1', read: 100 }]);
    if (path.startsWith(`/consumption/daily/${METER_COUNT}/`)) {
      const [rangeFrom, rangeTo] = path.split('/').slice(-2) as [string, string];
      const rows: unknown[] = [];
      for (let date = rangeFrom; date <= rangeTo && date <= publishedThrough; date = shiftDays(date, 1)) {
        rows.push({ meterCount: METER_COUNT, consDate: `${date}T00:00:00`, cons: 1 });
      }
      return json(rows);
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const config: WaterConfig = { email: 'a@example.com', password: 'x', pollIntervalMs: 60_000, weeklyWindow: 'sunday', pricePerCubicMeter: null };

  const points = await collectWater(config, from, to, SILENT_LOG, { includeMeterReading: true });

  const readingPoints = points.filter((p) => p.metric === 'israel_utility_water_meter_reading_cubic_meters');
  const todayPoints = readingPoints.filter((p) => p.timestampMs >= dateToEpochSeconds(to) * 1000);
  assert.ok(todayPoints.length > 1, 'today should get the live reading, densified — not skipped just because the portal lags');
  assert.ok(
    todayPoints.every((p) => p.value === 100),
    'today\'s samples should carry the live reading, not a value reconstructed from lagged daily consumption',
  );
});

test('reconstructMeterReadings walks backward from the newest known day, subtracting each day\'s consumption', () => {
  const dailyConsumption = new Map([
    ['2026-01-01', 1],
    ['2026-01-02', 2],
    ['2026-01-03', 3],
  ]);
  const readings = reconstructMeterReadings(100, dailyConsumption, '2026-01-01', '2026-01-03', '2026-01-03', SILENT_LOG, '777');
  assert.deepEqual(
    new Map(readings.map((r) => [r.date, r.value])),
    new Map([
      ['2026-01-03', 100],
      ['2026-01-02', 97],
      ['2026-01-01', 95],
    ]),
  );
});

test('reconstructMeterReadings only returns readings within [from, to], even when the anchor is well after `to`', () => {
  // today (the anchor) is days after the requested range — a real scenario, since water's
  // anchor is always today's live reading regardless of how old the backfilled range is.
  // Every day between the anchor and `to` still has to be walked to arrive at the right
  // running total, but only [from, to] should come back.
  const dailyConsumption = new Map([
    ['2026-01-01', 1],
    ['2026-01-02', 2],
    ['2026-01-03', 3],
    ['2026-01-04', 4],
    ['2026-01-05', 5],
    ['2026-01-06', 6],
  ]);
  const readings = reconstructMeterReadings(200, dailyConsumption, '2026-01-01', '2026-01-03', '2026-01-06', SILENT_LOG, '777');
  assert.deepEqual(
    new Map(readings.map((r) => [r.date, r.value])),
    new Map([
      ['2026-01-03', 185],
      ['2026-01-02', 182],
      ['2026-01-01', 180],
    ]),
  );
});

test('reconstructMeterReadings anchors on the newest published day, not literally today, absorbing an unpublished tail', () => {
  const dailyConsumption = new Map([
    ['2026-01-01', 1],
    ['2026-01-02', 2],
    // 2026-01-03 (== today) hasn't been published yet, same as real portal lag.
  ]);
  const readings = reconstructMeterReadings(100, dailyConsumption, '2026-01-01', '2026-01-03', '2026-01-03', SILENT_LOG, '777');
  assert.deepEqual(
    new Map(readings.map((r) => [r.date, r.value])),
    new Map([
      ['2026-01-02', 100],
      ['2026-01-01', 98],
    ]),
  );
});

test('reconstructMeterReadings stops at the first day with no published consumption instead of guessing', () => {
  const dailyConsumption = new Map([
    ['2026-01-01', 1],
    // 2026-01-02 missing entirely — a real gap, not just today's lag — so
    // 2026-01-02's own reading is computable (needs only 01-03's known
    // consumption), but nothing before it is, since that would need 01-02's.
    ['2026-01-03', 3],
  ]);
  const readings = reconstructMeterReadings(100, dailyConsumption, '2026-01-01', '2026-01-03', '2026-01-03', SILENT_LOG, '777');
  assert.deepEqual(
    new Map(readings.map((r) => [r.date, r.value])),
    new Map([
      ['2026-01-03', 100],
      ['2026-01-02', 97],
    ]),
  );
});

test('reconstructMeterReadings stops rather than writing a negative reading', () => {
  const dailyConsumption = new Map([
    ['2026-01-01', 90],
    ['2026-01-02', 40],
    ['2026-01-03', 5],
  ]);
  const readings = reconstructMeterReadings(50, dailyConsumption, '2025-12-30', '2026-01-03', '2026-01-03', SILENT_LOG, '777');
  // 01-03=50, minus 5 -> 01-02=45, minus 40 -> 01-01=5, minus 90 would be -85: stop there.
  assert.deepEqual(
    new Map(readings.map((r) => [r.date, r.value])),
    new Map([
      ['2026-01-03', 50],
      ['2026-01-02', 45],
      ['2026-01-01', 5],
    ]),
  );
});

test('reconstructMeterReadings returns nothing without a current reading to anchor to', () => {
  const readings = reconstructMeterReadings(null, new Map([['2026-01-01', 1]]), '2026-01-01', '2026-01-01', '2026-01-01', SILENT_LOG, '777');
  assert.deepEqual(readings, []);
});

test('reconstructMeterReadings returns nothing when no consumption has been published to anchor on', () => {
  const readings = reconstructMeterReadings(100, new Map(), '2026-01-01', '2026-01-05', '2026-01-05', SILENT_LOG, '777');
  assert.deepEqual(readings, []);
});

test('reconstructMeterReadings returns nothing when the newest published day is before the requested range', () => {
  const readings = reconstructMeterReadings(100, new Map([['2025-12-01', 1]]), '2026-01-01', '2026-01-05', '2026-01-05', SILENT_LOG, '777');
  assert.deepEqual(readings, []);
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
function fakeIecMonthlyWithDailyBreakdown(
  dailyByLocalDate: Record<string, number>,
  monthTotal: number,
  periodEndReading?: { totalImport: number; asOf: string },
) {
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
            totalImport: periodEndReading?.totalImport,
            totalImportDateForPeriod: periodEndReading?.asOf,
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
  const config: ElectricityConfig = {
    israeliId: VALID_ID,
    tokenFile,
    pollIntervalMs: 3_600_000,
    tariffMode: 'flat',
    pricePerKwh: null,
    tariffScheduleFile: null,
    vatPercent: 0,
  };

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

  // Monthly is a running month-to-date total (one sample per day, mirroring
  // what the live gauge would have shown if scraped that day) — not a
  // single point at the 1st carrying the whole month's eventual total.
  const monthlyPoints = points.filter((p) => p.metric === 'israel_utility_electricity_consumption_monthly_kwh');
  const monthlyByTimestamp = new Map(monthlyPoints.map((p) => [p.timestampMs, p.value]));
  assert.deepEqual(
    monthlyByTimestamp,
    new Map([
      [dateToEpochSeconds('2026-01-01') * 1000, 1],
      [dateToEpochSeconds('2026-01-02') * 1000, 3],
      [dateToEpochSeconds('2026-01-03') * 1000, 6],
    ]),
  );
});

test('collectElectricity computes the monthly running total from the whole month even when `from` starts mid-month', async () => {
  // A day before `from` (Jan 1) must still contribute to Jan 2's/3's
  // cumulative — MONTHLY returns the whole month regardless of the
  // requested from/to — but must not itself be written as a monthly sample.
  globalThis.fetch = fakeIecMonthlyWithDailyBreakdown(
    { '2026-01-01': 10, '2026-01-02': 2, '2026-01-03': 3 },
    15,
  ) as typeof fetch;

  const dataDir = mkdtempSync(join(tmpdir(), 'backfill-electricity-'));
  const tokenFile = join(dataDir, 'iec-token.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );
  const config: ElectricityConfig = {
    israeliId: VALID_ID,
    tokenFile,
    pollIntervalMs: 3_600_000,
    tariffMode: 'flat',
    pricePerKwh: null,
    tariffScheduleFile: null,
    vatPercent: 0,
  };

  const points = await collectElectricity(config, '2026-01-02', '2026-01-03', SILENT_LOG);

  const monthlyPoints = points.filter((p) => p.metric === 'israel_utility_electricity_consumption_monthly_kwh');
  const monthlyByTimestamp = new Map(monthlyPoints.map((p) => [p.timestampMs, p.value]));
  assert.deepEqual(
    monthlyByTimestamp,
    new Map([
      [dateToEpochSeconds('2026-01-02') * 1000, 12], // 10 (Jan 1, not written) + 2
      [dateToEpochSeconds('2026-01-03') * 1000, 15], // + 3
    ]),
  );
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
  const config: ElectricityConfig = {
    israeliId: VALID_ID,
    tokenFile,
    pollIntervalMs: 3_600_000,
    tariffMode: 'flat',
    pricePerKwh: null,
    tariffScheduleFile: null,
    vatPercent: 0,
  };

  const points = await collectElectricity(config, '2026-01-01', '2026-01-03', SILENT_LOG);

  const dailyPoints = points.filter((p) => p.metric === 'israel_utility_electricity_consumption_daily_kwh');
  assert.equal(dailyPoints.length, 1, 'the malformed-interval period must be skipped, not turned into a NaN-timestamped sample');
  assert.ok(dailyPoints.every((p) => Number.isFinite(p.timestampMs)));
  assert.equal(dailyPoints[0]!.timestampMs, dateToEpochSeconds('2026-01-02') * 1000);
});

test('collectElectricity does not backfill the meter reading unless includeMeterReading is set', async () => {
  globalThis.fetch = fakeIecMonthlyWithDailyBreakdown(
    { '2026-01-01': 1, '2026-01-02': 2, '2026-01-03': 3 },
    6,
    { totalImport: 100, asOf: '2026-01-31' },
  ) as typeof fetch;

  const dataDir = mkdtempSync(join(tmpdir(), 'backfill-electricity-'));
  const tokenFile = join(dataDir, 'iec-token.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );
  const config: ElectricityConfig = {
    israeliId: VALID_ID,
    tokenFile,
    pollIntervalMs: 3_600_000,
    tariffMode: 'flat',
    pricePerKwh: null,
    tariffScheduleFile: null,
    vatPercent: 0,
  };

  const points = await collectElectricity(config, '2026-01-01', '2026-01-03', SILENT_LOG);
  assert.equal(points.filter((p) => p.metric === 'israel_utility_electricity_meter_reading_kwh').length, 0);
});

test('collectElectricity reconstructs the meter reading from IEC\'s own dated reading when includeMeterReading is set', async () => {
  globalThis.fetch = fakeIecMonthlyWithDailyBreakdown(
    { '2026-01-01': 1, '2026-01-02': 2, '2026-01-03': 3 },
    6,
    { totalImport: 100, asOf: '2026-01-03' },
  ) as typeof fetch;

  const dataDir = mkdtempSync(join(tmpdir(), 'backfill-electricity-'));
  const tokenFile = join(dataDir, 'iec-token.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );
  const config: ElectricityConfig = {
    israeliId: VALID_ID,
    tokenFile,
    pollIntervalMs: 3_600_000,
    tariffMode: 'flat',
    pricePerKwh: null,
    tariffScheduleFile: null,
    vatPercent: 0,
  };

  const points = await collectElectricity(config, '2026-01-01', '2026-01-03', SILENT_LOG, { includeMeterReading: true });

  const readingPoints = points.filter((p) => p.metric === 'israel_utility_electricity_meter_reading_kwh');
  // Anchored at 100 on 01-03; walking backward: 01-03=100, 01-02=100-3=97, 01-01=97-2=95.
  assert.deepEqual(
    new Map(readingPoints.map((p) => [p.timestampMs, p.value])),
    new Map([
      [dateToEpochSeconds('2026-01-03') * 1000, 100],
      [dateToEpochSeconds('2026-01-02') * 1000, 97],
      [dateToEpochSeconds('2026-01-01') * 1000, 95],
    ]),
  );
});

test('collectElectricity writes a same-day point from the live reading even when periodEndReading lags several days behind', async () => {
  const to = isoDate(new Date());
  const from = shiftDays(to, -5);
  const anchorDate = shiftDays(to, -3); // IEC's own dated reading lags a few days behind "today"
  const LIVE_TOTAL_IMPORT = 500;

  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    if (u.hostname !== 'iecapi.iec.co.il') return new Response('', { status: 404 });
    if (u.pathname === '/api/customer') return json({ bpNumber: 'BP1' });
    if (u.pathname === '/api/customer/contract/BP1') return json({ contracts: [{ contractId: CONTRACT_ID }] });
    if (u.pathname === `/api/Device/${CONTRACT_ID}`) return json([{ deviceNumber: METER_SERIAL, deviceCode: METER_CODE }]);
    if (u.pathname === `/api/Consumption/RemoteReadingRange/${CONTRACT_ID}`) {
      const body = JSON.parse(init.body as string) as { resolution: number; fromDate: string };
      if (body.resolution !== ReadingResolution.MONTHLY) {
        return json({ meterList: [{ totalConsumptionForPeriod: 0 }] });
      }
      const monthKey = body.fromDate.slice(0, 7);
      const monthStart = `${monthKey}-01`;
      const [y, m] = monthStart.split('-').map(Number) as [number, number];
      const monthEnd = isoDate(new Date(y, m, 0));
      // Only publish daily data up through anchorDate — simulating IEC's real-world lag —
      // and only for whichever month is actually anchored (the current one).
      const isAnchorMonth = monthKey === anchorDate.slice(0, 7);
      const periodConsumptions: Array<{ interval: string; consumption: number }> = [];
      for (let d = monthStart; d <= monthEnd && (!isAnchorMonth || d <= anchorDate); d = shiftDays(d, 1)) {
        periodConsumptions.push({ interval: new Date(dateToEpochSeconds(d) * 1000).toISOString(), consumption: 1 });
      }
      return json({
        meterList: [
          {
            totalConsumptionForPeriod: periodConsumptions.length,
            totalImport: isAnchorMonth ? LIVE_TOTAL_IMPORT : undefined,
            totalImportDateForPeriod: isAnchorMonth ? anchorDate : undefined,
            periodConsumptions,
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
  const config: ElectricityConfig = {
    israeliId: VALID_ID,
    tokenFile,
    pollIntervalMs: 3_600_000,
    tariffMode: 'flat',
    pricePerKwh: null,
    tariffScheduleFile: null,
    vatPercent: 0,
  };

  const points = await collectElectricity(config, from, to, SILENT_LOG, { includeMeterReading: true });

  const readingPoints = points.filter((p) => p.metric === 'israel_utility_electricity_meter_reading_kwh');
  const todayPoints = readingPoints.filter((p) => p.timestampMs >= dateToEpochSeconds(to) * 1000);
  assert.ok(todayPoints.length > 1, 'today should get the live reading, densified — not skipped just because periodEndReading lags');
  assert.ok(
    todayPoints.every((p) => p.value === LIVE_TOTAL_IMPORT),
    'today\'s samples should carry the live totalImport, not a value reconstructed from the lagged anchor',
  );
});

test('reconstructElectricityMeterReading walks backward from IEC\'s own dated reading', () => {
  const dailyConsumption = new Map([
    ['2026-01-01', 1],
    ['2026-01-02', 2],
    ['2026-01-03', 3],
  ]);
  const readings = reconstructElectricityMeterReading(100, '2026-01-03', dailyConsumption, '2026-01-01', '2026-01-03', SILENT_LOG, '900123456');
  assert.deepEqual(
    new Map(readings.map((r) => [r.date, r.value])),
    new Map([
      ['2026-01-03', 100],
      ['2026-01-02', 97],
      ['2026-01-01', 95],
    ]),
  );
});

test('reconstructElectricityMeterReading returns nothing without a dated reading to anchor to', () => {
  assert.deepEqual(reconstructElectricityMeterReading(null, null, new Map(), '2026-01-01', '2026-01-03', SILENT_LOG, '900123456'), []);
  assert.deepEqual(reconstructElectricityMeterReading(100, null, new Map(), '2026-01-01', '2026-01-03', SILENT_LOG, '900123456'), []);
});

test('reconstructElectricityMeterReading returns nothing and warns when the dated reading is before the requested range', () => {
  const warnings: string[] = [];
  const log: Logger = { ...SILENT_LOG, warn: (message) => warnings.push(message) };
  const readings = reconstructElectricityMeterReading(100, '2025-12-31', new Map(), '2026-01-01', '2026-01-03', log, '900123456');
  assert.deepEqual(readings, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /900123456/);
  assert.match(warnings[0]!, /2025-12-31/);
});

test('reconstructElectricityMeterReading stops at the first day with no published consumption instead of guessing', () => {
  const dailyConsumption = new Map([
    ['2026-01-01', 1],
    // 2026-01-02 missing
    ['2026-01-03', 3],
  ]);
  const readings = reconstructElectricityMeterReading(100, '2026-01-03', dailyConsumption, '2026-01-01', '2026-01-03', SILENT_LOG, '900123456');
  assert.deepEqual(
    new Map(readings.map((r) => [r.date, r.value])),
    new Map([
      ['2026-01-03', 100],
      ['2026-01-02', 97],
    ]),
  );
});

test('reconstructElectricityMeterReading stops rather than writing a negative reading', () => {
  const dailyConsumption = new Map([
    ['2026-01-01', 90],
    ['2026-01-02', 40],
    ['2026-01-03', 5],
  ]);
  const readings = reconstructElectricityMeterReading(50, '2026-01-03', dailyConsumption, '2025-12-30', '2026-01-03', SILENT_LOG, '900123456');
  assert.deepEqual(
    new Map(readings.map((r) => [r.date, r.value])),
    new Map([
      ['2026-01-03', 50],
      ['2026-01-02', 45],
      ['2026-01-01', 5],
    ]),
  );
});

test('buildEstimatedReadingsPrompt names only the meter(s) actually being backfilled', () => {
  assert.match(buildEstimatedReadingsPrompt(true, false), /water meter reading/);
  assert.doesNotMatch(buildEstimatedReadingsPrompt(true, false), /electricity meter reading/);
  assert.match(buildEstimatedReadingsPrompt(false, true), /electricity meter reading/);
  assert.doesNotMatch(buildEstimatedReadingsPrompt(false, true), /water meter reading/);
  const both = buildEstimatedReadingsPrompt(true, true);
  assert.match(both, /water meter reading/);
  assert.match(both, /electricity meter reading/);
});

test('resolveIncludeEstimated returns the explicit flag without prompting', async () => {
  assert.equal(await resolveIncludeEstimated({ service: 'water', dryRun: false, includeEstimated: true }, true, false), true);
  assert.equal(await resolveIncludeEstimated({ service: 'water', dryRun: false, includeEstimated: false }, true, false), false);
});

test('resolveIncludeEstimated defaults to false on a non-interactive terminal instead of prompting', async () => {
  // The test runner's stdin is never a TTY, so this exercises the same branch a CI run hits.
  assert.equal(await resolveIncludeEstimated({ service: 'water', dryRun: false, includeEstimated: undefined }, true, false), false);
});

test('collectWater in tiered mode also backfills the threshold, effective rate and cost gauges from the running monthly total', async () => {
  globalThis.fetch = fakeWaterPortal() as typeof fetch;

  const tariffTiers = { normalRatePerCubicMeter: 5, excessRatePerCubicMeter: 10, householdSize: 1, allowancePerPersonCubicMeters: 3.5 };
  const config: WaterConfig = {
    email: 'a@example.com',
    password: 'x',
    pollIntervalMs: 60_000,
    weeklyWindow: 'sunday',
    tariffMode: 'tiered',
    pricePerCubicMeter: null,
    tariffTiers,
  };
  const points = await collectWater(config, '2026-01-01', '2026-01-03', SILENT_LOG);

  // fakeWaterPortal reports 1 m3/day, so the running monthly total is 1, 2, 3 m3 — all below the 7 m3 threshold.
  const thresholdPoints = points.filter((p) => p.metric === 'israel_utility_water_tariff_threshold_cubic_meters');
  assert.equal(thresholdPoints.length, 3);
  assert.ok(thresholdPoints.every((p) => p.value === waterTariffThreshold(tariffTiers)));

  const ratePoints = points.filter((p) => p.metric === 'israel_utility_water_effective_rate_ils_per_cubic_meter');
  assert.deepEqual(
    new Map(ratePoints.map((p) => [p.timestampMs, p.value])),
    new Map([
      [dateToEpochSeconds('2026-01-01') * 1000, 5],
      [dateToEpochSeconds('2026-01-02') * 1000, 5],
      [dateToEpochSeconds('2026-01-03') * 1000, 5],
    ]),
  );

  const normalRatePoints = points.filter((p) => p.metric === 'israel_utility_water_tariff_normal_rate_ils_per_cubic_meter');
  assert.equal(normalRatePoints.length, 3);
  assert.ok(normalRatePoints.every((p) => p.value === tariffTiers.normalRatePerCubicMeter));

  const costPoints = points.filter((p) => p.metric === 'israel_utility_water_cost_estimate_ils');
  assert.deepEqual(
    new Map(costPoints.map((p) => [p.timestampMs, p.value])),
    new Map([
      [dateToEpochSeconds('2026-01-01') * 1000, tieredWaterCost(tariffTiers, 1)],
      [dateToEpochSeconds('2026-01-02') * 1000, tieredWaterCost(tariffTiers, 2)],
      [dateToEpochSeconds('2026-01-03') * 1000, tieredWaterCost(tariffTiers, 3)],
    ]),
  );
});

test('collectWater in flat mode backfills the cost gauge but not the tiered-only threshold/rate gauges', async () => {
  globalThis.fetch = fakeWaterPortal() as typeof fetch;

  const config: WaterConfig = {
    email: 'a@example.com',
    password: 'x',
    pollIntervalMs: 60_000,
    weeklyWindow: 'sunday',
    tariffMode: 'flat',
    pricePerCubicMeter: 3,
    tariffTiers: null,
  };
  const points = await collectWater(config, '2026-01-01', '2026-01-02', SILENT_LOG);

  assert.equal(points.filter((p) => p.metric === 'israel_utility_water_tariff_threshold_cubic_meters').length, 0);
  assert.equal(points.filter((p) => p.metric === 'israel_utility_water_effective_rate_ils_per_cubic_meter').length, 0);

  const costPoints = points.filter((p) => p.metric === 'israel_utility_water_cost_estimate_ils');
  assert.deepEqual(
    new Map(costPoints.map((p) => [p.timestampMs, p.value])),
    new Map([
      [dateToEpochSeconds('2026-01-01') * 1000, 3],
      [dateToEpochSeconds('2026-01-02') * 1000, 6],
    ]),
  );
});

test('collectWater backfills no cost gauge at all when unpriced', async () => {
  globalThis.fetch = fakeWaterPortal() as typeof fetch;

  const config: WaterConfig = {
    email: 'a@example.com',
    password: 'x',
    pollIntervalMs: 60_000,
    weeklyWindow: 'sunday',
    tariffMode: 'flat',
    pricePerCubicMeter: null,
    tariffTiers: null,
  };
  const points = await collectWater(config, '2026-01-01', '2026-01-02', SILENT_LOG);

  assert.equal(points.filter((p) => p.metric === 'israel_utility_water_cost_estimate_ils').length, 0);
});

test('collectWater backfills the previous-month cost gauge from the extra month it fetches but does not otherwise expose', async () => {
  globalThis.fetch = fakeWaterPortal() as typeof fetch;

  const config: WaterConfig = {
    email: 'a@example.com',
    password: 'x',
    pollIntervalMs: 60_000,
    weeklyWindow: 'sunday',
    tariffMode: 'flat',
    pricePerCubicMeter: 3,
    tariffTiers: null,
  };
  const points = await collectWater(config, '2026-01-01', '2026-01-03', SILENT_LOG);

  // fakeWaterPortal reports 1 m3/day for whatever range is requested, and
  // `collectWater` now fetches starting a month before `from` specifically so
  // December's total is available — all 31 days of it, since `from` here is
  // the 1st, so no leading days are cut off by the requested range.
  const previousMonthPoints = points.filter((p) => p.metric === 'israel_utility_water_cost_estimate_previous_month_ils');
  assert.equal(previousMonthPoints.length, 3, 'one per requested day (2026-01-01 through 2026-01-03)');
  assert.ok(previousMonthPoints.every((p) => p.value === waterCostEstimate(config, 31)));
  assert.ok(previousMonthPoints.every((p) => p.labels.month === 'Dec'));
});

test('collectWater leaves the previous-month cost gauge unset when the account has no data that far back, rather than a misleading ₪0', async () => {
  // The portal reports nothing before 2026-01-01 (as if the account was
  // only created that day), so the extra month `collectWater` reaches back
  // to (December) comes back empty.
  const accountStart = '2026-01-01';
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/consumer/login') return json({ token: 'tok' });
    if (path === '/consumption/last-read') return json([{ meterCount: METER_COUNT, meterId: 'SER1', read: 100 }]);
    if (path.startsWith(`/consumption/daily/${METER_COUNT}/`)) {
      const [from, to] = path.split('/').slice(-2) as [string, string];
      const rows: unknown[] = [];
      for (let date = from; date <= to; date = shiftDays(date, 1)) {
        if (date >= accountStart) {
          rows.push({ meterCount: METER_COUNT, consDate: `${date}T00:00:00`, cons: 1 });
        }
      }
      return json(rows);
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;

  const config: WaterConfig = {
    email: 'a@example.com',
    password: 'x',
    pollIntervalMs: 60_000,
    weeklyWindow: 'sunday',
    tariffMode: 'flat',
    pricePerCubicMeter: 3,
    tariffTiers: null,
  };
  const points = await collectWater(config, '2026-01-01', '2026-01-03', SILENT_LOG);

  assert.equal(
    points.filter((p) => p.metric === 'israel_utility_water_cost_estimate_previous_month_ils').length,
    0,
    'no December data exists, so no previous-month point should be written at all — not one priced at ₪0',
  );
});

test('collectElectricity in flat mode backfills the cost gauge from a fixed price per kWh, without an effective-rate gauge', async () => {
  globalThis.fetch = fakeIecMonthlyWithDailyBreakdown({ '2026-01-01': 1, '2026-01-02': 2, '2026-01-03': 3 }, 6) as typeof fetch;

  const dataDir = mkdtempSync(join(tmpdir(), 'backfill-electricity-'));
  const tokenFile = join(dataDir, 'iec-token.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );
  const config: ElectricityConfig = {
    israeliId: VALID_ID,
    tokenFile,
    pollIntervalMs: 3_600_000,
    tariffMode: 'flat',
    pricePerKwh: 2,
    tariffScheduleFile: null,
    vatPercent: 0,
  };

  const points = await collectElectricity(config, '2026-01-01', '2026-01-03', SILENT_LOG);

  assert.equal(points.filter((p) => p.metric === 'israel_utility_electricity_effective_rate_ils_per_kwh').length, 0);

  const costPoints = points.filter((p) => p.metric === 'israel_utility_electricity_cost_estimate_ils');
  assert.deepEqual(
    new Map(costPoints.map((p) => [p.timestampMs, p.value])),
    new Map([
      [dateToEpochSeconds('2026-01-01') * 1000, 2],
      [dateToEpochSeconds('2026-01-02') * 1000, 4],
      [dateToEpochSeconds('2026-01-03') * 1000, 6],
    ]),
  );

  const monthlyCostPoints = points.filter((p) => p.metric === 'israel_utility_electricity_cost_estimate_monthly_ils');
  assert.deepEqual(
    new Map(monthlyCostPoints.map((p) => [p.timestampMs, p.value])),
    new Map([
      [dateToEpochSeconds('2026-01-01') * 1000, 2],
      [dateToEpochSeconds('2026-01-02') * 1000, 6],
      [dateToEpochSeconds('2026-01-03') * 1000, 12],
    ]),
  );
});

test('collectElectricity in schedule mode backfills the effective-rate and cost gauges via blendedRateForDay', async () => {
  globalThis.fetch = fakeIecMonthlyWithDailyBreakdown({ '2026-01-01': 1, '2026-01-02': 2 }, 3) as typeof fetch;

  const dataDir = mkdtempSync(join(tmpdir(), 'backfill-electricity-'));
  const tokenFile = join(dataDir, 'iec-token.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );
  const scheduleFile = join(dataDir, 'schedule.json');
  const schedule = {
    baseRatePerKwh: 2,
    windows: [{ days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], start: '17:00', end: '23:00', discountPercent: 50 }],
  };
  writeFileSync(scheduleFile, JSON.stringify(schedule));
  const config: ElectricityConfig = {
    israeliId: VALID_ID,
    tokenFile,
    pollIntervalMs: 3_600_000,
    tariffMode: 'schedule',
    pricePerKwh: null,
    tariffScheduleFile: scheduleFile,
    vatPercent: 0,
  };

  const points = await collectElectricity(config, '2026-01-01', '2026-01-02', SILENT_LOG);

  const expectedRate = (date: string) => blendedRateForDay(schedule, parseYmdNoon(date));

  const ratePoints = points.filter((p) => p.metric === 'israel_utility_electricity_effective_rate_ils_per_kwh');
  assert.deepEqual(
    new Map(ratePoints.map((p) => [p.timestampMs, p.value])),
    new Map([
      [dateToEpochSeconds('2026-01-01') * 1000, expectedRate('2026-01-01')],
      [dateToEpochSeconds('2026-01-02') * 1000, expectedRate('2026-01-02')],
    ]),
  );

  const costPoints = points.filter((p) => p.metric === 'israel_utility_electricity_cost_estimate_ils');
  assert.deepEqual(
    new Map(costPoints.map((p) => [p.timestampMs, p.value])),
    new Map([
      [dateToEpochSeconds('2026-01-01') * 1000, 1 * expectedRate('2026-01-01')],
      [dateToEpochSeconds('2026-01-02') * 1000, 2 * expectedRate('2026-01-02')],
    ]),
  );

  const monthlyCostPoints = points.filter((p) => p.metric === 'israel_utility_electricity_cost_estimate_monthly_ils');
  assert.deepEqual(
    new Map(monthlyCostPoints.map((p) => [p.timestampMs, p.value])),
    new Map([
      [dateToEpochSeconds('2026-01-01') * 1000, 1 * expectedRate('2026-01-01')],
      [dateToEpochSeconds('2026-01-02') * 1000, 1 * expectedRate('2026-01-01') + 2 * expectedRate('2026-01-02')],
    ]),
  );
});

/**
 * Unlike `fakeIecMonthlyWithDailyBreakdown`, this branches on the requested
 * month (`fromDate`'s YYYY-MM) instead of returning the same daily data for
 * every MONTHLY call — needed to exercise the previous-month backfill, which
 * depends on different months genuinely holding different data.
 */
function fakeIecMonthlyByMonth(byMonthKey: Record<string, { daily: Record<string, number>; monthTotal: number }>) {
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
      const body = JSON.parse(init.body as string) as { resolution: number; fromDate: string };
      if (body.resolution !== ReadingResolution.MONTHLY) {
        return json({ meterList: [{ totalConsumptionForPeriod: 0 }] });
      }
      const month = byMonthKey[body.fromDate.slice(0, 7)];
      return json({
        meterList: [
          {
            totalConsumptionForPeriod: month?.monthTotal ?? 0,
            periodConsumptions: Object.entries(month?.daily ?? {}).map(([localDate, consumption]) => ({
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

test('collectElectricity backfills the previous-month cost gauge, bootstrapping the first requested month and rolling forward after that', async () => {
  globalThis.fetch = fakeIecMonthlyByMonth({
    '2025-12': { daily: { '2025-12-01': 1, '2025-12-02': 1 }, monthTotal: 2 },
    '2026-01': { daily: { '2026-01-01': 2, '2026-01-02': 2 }, monthTotal: 4 },
    '2026-02': { daily: { '2026-02-01': 3 }, monthTotal: 3 },
  }) as typeof fetch;

  const dataDir = mkdtempSync(join(tmpdir(), 'backfill-electricity-'));
  const tokenFile = join(dataDir, 'iec-token.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );
  const config: ElectricityConfig = {
    israeliId: VALID_ID,
    tokenFile,
    pollIntervalMs: 3_600_000,
    tariffMode: 'flat',
    pricePerKwh: 2,
    tariffScheduleFile: null,
    vatPercent: 0,
  };

  const points = await collectElectricity(config, '2026-01-01', '2026-02-01', SILENT_LOG);

  const previousMonthPoints = points.filter((p) => p.metric === 'israel_utility_electricity_cost_estimate_previous_month_ils');

  // January's days: "previous month" is December, only reachable via the
  // bootstrap fetch (December isn't otherwise requested at all).
  const januaryPoints = previousMonthPoints.filter((p) => p.timestampMs < dateToEpochSeconds('2026-02-01') * 1000);
  assert.equal(januaryPoints.length, 2);
  assert.ok(januaryPoints.every((p) => p.value === 2 * 2), 'December: 1+1 kWh at 2 ILS/kWh');
  assert.ok(januaryPoints.every((p) => p.labels.month === 'Dec'));

  // February's day: "previous month" is January, available by rolling
  // forward January's own already-fetched data, not a second fetch of it.
  const februaryPoints = previousMonthPoints.filter((p) => p.timestampMs >= dateToEpochSeconds('2026-02-01') * 1000);
  assert.equal(februaryPoints.length, 1);
  assert.ok(februaryPoints.every((p) => p.value === 4 * 2), 'January: 2+2 kWh at 2 ILS/kWh');
  assert.ok(februaryPoints.every((p) => p.labels.month === 'Jan'));
});

test('collectElectricity leaves the previous-month cost gauge unset when the bootstrap month has no data, rather than a misleading ₪0', async () => {
  // '2025-12' is deliberately absent from the map — `fakeIecMonthlyByMonth`
  // reports an empty period list for any month it doesn't recognize, as IEC
  // would for an account that didn't exist yet.
  globalThis.fetch = fakeIecMonthlyByMonth({
    '2026-01': { daily: { '2026-01-01': 2 }, monthTotal: 2 },
  }) as typeof fetch;

  const dataDir = mkdtempSync(join(tmpdir(), 'backfill-electricity-'));
  const tokenFile = join(dataDir, 'iec-token.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );
  const config: ElectricityConfig = {
    israeliId: VALID_ID,
    tokenFile,
    pollIntervalMs: 3_600_000,
    tariffMode: 'flat',
    pricePerKwh: 2,
    tariffScheduleFile: null,
    vatPercent: 0,
  };

  const points = await collectElectricity(config, '2026-01-01', '2026-01-01', SILENT_LOG);

  assert.equal(
    points.filter((p) => p.metric === 'israel_utility_electricity_cost_estimate_previous_month_ils').length,
    0,
    'no December data exists, so no previous-month point should be written at all — not one priced at ₪0',
  );
});

test('collectElectricity grosses up the schedule\'s baseRatePerKwh by vatPercent, same as the live collector', async () => {
  globalThis.fetch = fakeIecMonthlyWithDailyBreakdown({ '2026-01-01': 1 }, 1) as typeof fetch;

  const dataDir = mkdtempSync(join(tmpdir(), 'backfill-electricity-'));
  const tokenFile = join(dataDir, 'iec-token.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );
  const scheduleFile = join(dataDir, 'schedule.json');
  // No windows, so the blended rate is just baseRatePerKwh grossed up by VAT.
  writeFileSync(scheduleFile, JSON.stringify({ baseRatePerKwh: 2, windows: [] }));
  const config: ElectricityConfig = {
    israeliId: VALID_ID,
    tokenFile,
    pollIntervalMs: 3_600_000,
    tariffMode: 'schedule',
    pricePerKwh: null,
    tariffScheduleFile: scheduleFile,
    vatPercent: 18,
  };

  const points = await collectElectricity(config, '2026-01-01', '2026-01-01', SILENT_LOG);

  const ratePoints = points.filter((p) => p.metric === 'israel_utility_electricity_effective_rate_ils_per_kwh');
  assert.deepEqual(new Map(ratePoints.map((p) => [p.timestampMs, p.value])), new Map([[dateToEpochSeconds('2026-01-01') * 1000, 2.36]]));

  const costPoints = points.filter((p) => p.metric === 'israel_utility_electricity_cost_estimate_ils');
  assert.deepEqual(new Map(costPoints.map((p) => [p.timestampMs, p.value])), new Map([[dateToEpochSeconds('2026-01-01') * 1000, 2.36]]));
});

test('collectElectricity validates an invalid tariff schedule before making any IEC network call, not after', async () => {
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error('collectElectricity must not reach the network with an invalid tariff schedule');
  }) as typeof fetch;

  const dataDir = mkdtempSync(join(tmpdir(), 'backfill-electricity-'));
  const tokenFile = join(dataDir, 'iec-token.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );
  const scheduleFile = join(dataDir, 'schedule.json');
  writeFileSync(scheduleFile, 'not valid json');
  const config: ElectricityConfig = {
    israeliId: VALID_ID,
    tokenFile,
    pollIntervalMs: 3_600_000,
    tariffMode: 'schedule',
    pricePerKwh: null,
    tariffScheduleFile: scheduleFile,
    vatPercent: 0,
  };

  await assert.rejects(() => collectElectricity(config, '2026-01-01', '2026-01-02', SILENT_LOG), TariffScheduleError);
  assert.equal(fetchCalled, false, 'a bad schedule file must fail before spending any IEC API quota, like the live collector does at boot');
});
