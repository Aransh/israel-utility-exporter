import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildTimeSeries } from '../src/remote-write/series-builder.js';

test('groups points with the same metric+labels into one series, sorted by time', () => {
  const series = buildTimeSeries([
    { metric: 'm', labels: { a: '1' }, timestampMs: 2000, value: 2 },
    { metric: 'm', labels: { a: '1' }, timestampMs: 1000, value: 1 },
  ]);
  assert.equal(series.length, 1);
  assert.deepEqual(
    series[0]!.samples.map((s) => s.timestampMs),
    [1000, 2000],
  );
});

test('keeps different metrics and different label sets as separate series', () => {
  const series = buildTimeSeries([
    { metric: 'm', labels: { a: '1' }, timestampMs: 1000, value: 1 },
    { metric: 'm', labels: { a: '2' }, timestampMs: 1000, value: 2 },
    { metric: 'n', labels: { a: '1' }, timestampMs: 1000, value: 3 },
  ]);
  assert.equal(series.length, 3);
});

test('every series carries a __name__ label matching its metric', () => {
  const [series] = buildTimeSeries([{ metric: 'my_metric', labels: { x: 'y' }, timestampMs: 1000, value: 1 }]);
  assert.deepEqual(series!.labels, [
    { name: '__name__', value: 'my_metric' },
    { name: 'x', value: 'y' },
  ]);
});
