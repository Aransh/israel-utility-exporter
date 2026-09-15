import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { blendedRateForDay, loadTariffSchedule, TariffScheduleError } from '../src/cost/tariff.js';

function scheduleFile(json: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'tariff-'));
  const path = join(dir, 'schedule.json');
  writeFileSync(path, JSON.stringify(json));
  return path;
}

// A Thursday and a Saturday, so weekday-vs-weekend windows can be told apart
// regardless of which day the suite happens to run on.
const THURSDAY = new Date(2026, 8, 17, 12); // 2026-09-17
const SATURDAY = new Date(2026, 8, 19, 12); // 2026-09-19

test('flat schedule (no windows) prices every day at the base rate', () => {
  const path = scheduleFile({ baseRatePerKwh: 0.6, windows: [] });
  const schedule = loadTariffSchedule(path);
  assert.equal(blendedRateForDay(schedule, THURSDAY), 0.6);
});

test('a window covering the whole day fully applies the discount', () => {
  const path = scheduleFile({
    baseRatePerKwh: 1,
    windows: [{ days: ['thu'], start: '00:00', end: '23:59', discountPercent: 50 }],
  });
  const schedule = loadTariffSchedule(path);
  // 23:59 leaves the last minute of the day at the base rate, negligible here.
  const rate = blendedRateForDay(schedule, THURSDAY);
  assert.ok(Math.abs(rate - 0.5) < 0.001, `expected ~0.5, got ${rate}`);
});

test('a partial-day window blends by duration', () => {
  // 70% off 17:00-23:00 (6h) on weekdays: (18h * 1 + 6h * 0.3) / 24h.
  const path = scheduleFile({
    baseRatePerKwh: 1,
    windows: [{ days: ['sun', 'mon', 'tue', 'wed', 'thu'], start: '17:00', end: '23:00', discountPercent: 70 }],
  });
  const schedule = loadTariffSchedule(path);
  const expected = (18 * 1 + 6 * 0.3) / 24;
  assert.ok(Math.abs(blendedRateForDay(schedule, THURSDAY) - expected) < 0.001);
});

test('a window only applies on the days it lists', () => {
  const path = scheduleFile({
    baseRatePerKwh: 1,
    windows: [{ days: ['sun', 'mon', 'tue', 'wed', 'thu'], start: '17:00', end: '23:00', discountPercent: 70 }],
  });
  const schedule = loadTariffSchedule(path);
  // Saturday is not in `days`, so no discount applies at all.
  assert.equal(blendedRateForDay(schedule, SATURDAY), 1);
});

test('non-overlapping windows for the same day combine correctly', () => {
  const path = scheduleFile({
    baseRatePerKwh: 1,
    windows: [
      { days: ['thu'], start: '00:00', end: '06:00', discountPercent: 50 }, // 6h @ 0.5
      { days: ['thu'], start: '17:00', end: '23:00', discountPercent: 70 }, // 6h @ 0.3
    ],
  });
  const schedule = loadTariffSchedule(path);
  // Remaining 12h @ 1.0
  const expected = (6 * 0.5 + 6 * 0.3 + 12 * 1) / 24;
  assert.ok(Math.abs(blendedRateForDay(schedule, THURSDAY) - expected) < 0.001);
});

test('rejects an overnight window instead of guessing which day it belongs to', () => {
  const path = scheduleFile({
    baseRatePerKwh: 1,
    windows: [{ days: ['thu'], start: '23:00', end: '01:00', discountPercent: 50 }],
  });
  assert.throws(() => loadTariffSchedule(path), TariffScheduleError);
});

test('rejects a schedule with no baseRatePerKwh', () => {
  const path = scheduleFile({ windows: [] });
  assert.throws(() => loadTariffSchedule(path), TariffScheduleError);
});

test('rejects malformed JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tariff-'));
  const path = join(dir, 'bad.json');
  writeFileSync(path, '{ not json');
  assert.throws(() => loadTariffSchedule(path), TariffScheduleError);
});
