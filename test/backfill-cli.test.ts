import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chunk, parseArgs, resolveRange } from '../src/backfill-cli.js';
import { isoDate } from '../src/time/day.js';

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
  assert.throws(() => parseArgs(['--days', '0']), /positive number/);
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

test('resolveRange turns --days into a from/to range ending today', () => {
  const range = resolveRange({ service: 'all', days: 10, dryRun: false });
  assert.equal(range.to, isoDate(new Date()));
  assert.ok(range.from < range.to);
});

test('chunk splits an array into groups of the given size, including a short last group', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
  assert.deepEqual(chunk([1], 5), [[1]]);
});
