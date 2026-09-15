import assert from 'node:assert/strict';
import { test } from 'node:test';

import { registry, waterGauges } from '../src/metrics.js';

test('a recorded snapshot renders into /metrics text', async () => {
  waterGauges.meterReadingCubicMeters.set({ meter_id: '1', meter_serial: 'ABC' }, 812.345);
  const body = await registry.metrics();
  assert.match(body, /israel_utility_water_meter_reading_cubic_meters\{meter_id="1",meter_serial="ABC"\} 812\.345/);
});

test('build info is always present', async () => {
  const body = await registry.metrics();
  assert.match(body, /israel_utility_exporter_build_info\{version="[^"]+"\} 1/);
});

test('a gauge that is never set is simply absent from the output, not zero', async () => {
  const body = await registry.metrics();
  // consumptionForecastLiters is never .set() in this file, so it must not
  // appear at all — Prometheus semantics for an unset gauge with labels.
  assert.doesNotMatch(body, /israel_utility_water_consumption_forecast_liters\{/);
});
