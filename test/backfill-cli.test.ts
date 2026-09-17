import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chunk, collectWater, parseArgs, resolveRange } from '../src/backfill-cli.js';
import type { WaterConfig } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import { dateToEpochSeconds, isoDate, shiftDays } from '../src/time/day.js';

const SILENT_LOG: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

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
  function json(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
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
  const config: WaterConfig = { email: 'a@example.com', password: 'x', pollIntervalMs: 60_000, weeklyWindow: 'sunday', pricePerCubicMeter: null };
  const points = await collectWater(config, '2026-01-07', '2026-01-24', SILENT_LOG);

  const weeklyPoints = points.filter((p) => p.metric === 'israel_utility_water_consumption_weekly_liters');
  assert.equal(weeklyPoints.length, 2, 'the partial leading week must be skipped, leaving only the 2 fully-covered weeks');

  const timestamps = weeklyPoints.map((p) => p.timestampMs).sort((a, b) => a - b);
  assert.deepEqual(timestamps, [dateToEpochSeconds('2026-01-17') * 1000, dateToEpochSeconds('2026-01-24') * 1000]);
});

test('collectWater includes a rolling weekly bucket that starts exactly at `from`', async () => {
  globalThis.fetch = fakeWaterPortal() as typeof fetch;

  const config: WaterConfig = { email: 'a@example.com', password: 'x', pollIntervalMs: 60_000, weeklyWindow: 'rolling', pricePerCubicMeter: null };
  const points = await collectWater(config, '2026-01-07', '2026-01-20', SILENT_LOG);

  const weeklyPoints = points.filter((p) => p.metric === 'israel_utility_water_consumption_weekly_liters');
  // rolling windows start exactly at `from`, so both 7-day buckets
  // (01-07..01-13 and 01-14..01-20) are fully covered by the fetched range.
  assert.equal(weeklyPoints.length, 2);
});
