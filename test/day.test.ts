import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dateToEpochSeconds, enumerateMonthStarts, isoDate, parseYmdNoon, shiftDays } from '../src/time/day.js';

test('dateToEpochSeconds matches local-midnight of the given day', () => {
  assert.equal(dateToEpochSeconds('2026-01-01'), new Date(2026, 0, 1).getTime() / 1000);
  assert.equal(dateToEpochSeconds('2026-03-15'), new Date(2026, 2, 15).getTime() / 1000);
});

test('parseYmdNoon anchors at local noon, not midnight', () => {
  const noon = parseYmdNoon('2026-06-01');
  assert.equal(noon.getHours(), 12);
  assert.equal(noon.getDate(), 1);
  assert.equal(noon.getMonth(), 5);
});

test('isoDate round-trips through parseYmdNoon', () => {
  assert.equal(isoDate(parseYmdNoon('2026-12-31')), '2026-12-31');
});

test('shiftDays moves by whole days, including across month/year boundaries', () => {
  assert.equal(shiftDays('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDays('2026-01-31', 1), '2026-02-01');
  assert.equal(shiftDays('2026-03-01', -7), '2026-02-22');
});

test('enumerateMonthStarts lists every calendar month from `from` through `to`, inclusive', () => {
  assert.deepEqual(enumerateMonthStarts('2026-01-15', '2026-03-02'), ['2026-01-01', '2026-02-01', '2026-03-01']);
});

test('enumerateMonthStarts handles a single month and a year rollover', () => {
  assert.deepEqual(enumerateMonthStarts('2026-05-01', '2026-05-31'), ['2026-05-01']);
  assert.deepEqual(enumerateMonthStarts('2025-11-15', '2026-01-05'), ['2025-11-01', '2025-12-01', '2026-01-01']);
});
