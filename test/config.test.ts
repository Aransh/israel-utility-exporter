import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigError, loadConfig } from '../src/config.js';

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { WATER_ENABLED: 'true', WATER_EMAIL: 'a@example.com', WATER_PASSWORD: 'x', ...overrides };
}

test('remoteWrite is null when REMOTE_WRITE_URL is not set', () => {
  const config = loadConfig(baseEnv());
  assert.equal(config.remoteWrite, null);
});

test('REMOTE_WRITE_EXTRA_LABELS parses a comma-separated key=value list', () => {
  const config = loadConfig(
    baseEnv({ REMOTE_WRITE_URL: 'http://localhost:8428/api/v1/write', REMOTE_WRITE_EXTRA_LABELS: 'job=israel-utility-exporter,instance=exporter:9877' }),
  );
  assert.deepEqual({ ...config.remoteWriteExtraLabels }, { job: 'israel-utility-exporter', instance: 'exporter:9877' });
});

test('REMOTE_WRITE_EXTRA_LABELS defaults to an empty map when unset', () => {
  const config = loadConfig(baseEnv({ REMOTE_WRITE_URL: 'http://localhost:8428/api/v1/write' }));
  assert.deepEqual({ ...config.remoteWriteExtraLabels }, {});
});

test('REMOTE_WRITE_EXTRA_LABELS trims whitespace around pairs and values', () => {
  const config = loadConfig(baseEnv({ REMOTE_WRITE_URL: 'http://localhost:8428/api/v1/write', REMOTE_WRITE_EXTRA_LABELS: ' job = israel-utility , env=prod ' }));
  assert.deepEqual({ ...config.remoteWriteExtraLabels }, { job: 'israel-utility', env: 'prod' });
});

test('REMOTE_WRITE_EXTRA_LABELS parses even without REMOTE_WRITE_URL set, so a --dry-run preview matches a real run', () => {
  const config = loadConfig(baseEnv({ REMOTE_WRITE_EXTRA_LABELS: 'job=israel-utility-exporter,instance=exporter:9877' }));
  assert.equal(config.remoteWrite, null);
  assert.deepEqual({ ...config.remoteWriteExtraLabels }, { job: 'israel-utility-exporter', instance: 'exporter:9877' });
});

test('REMOTE_WRITE_EXTRA_LABELS treats a "__proto__" label as an ordinary key, not a prototype reassignment', () => {
  const config = loadConfig(baseEnv({ REMOTE_WRITE_EXTRA_LABELS: '__proto__=oops' }));
  assert.equal(config.remoteWriteExtraLabels.__proto__, 'oops');
  assert.equal(Object.getPrototypeOf(config.remoteWriteExtraLabels), null);
});

test('REMOTE_WRITE_EXTRA_LABELS rejects an entry with no "="', () => {
  assert.throws(
    () => loadConfig(baseEnv({ REMOTE_WRITE_URL: 'http://localhost:8428/api/v1/write', REMOTE_WRITE_EXTRA_LABELS: 'job' })),
    ConfigError,
  );
});

test('REMOTE_WRITE_EXTRA_LABELS rejects an invalid Prometheus label name', () => {
  assert.throws(
    () => loadConfig(baseEnv({ REMOTE_WRITE_URL: 'http://localhost:8428/api/v1/write', REMOTE_WRITE_EXTRA_LABELS: '9job=bad' })),
    ConfigError,
  );
});

test('REMOTE_WRITE_EXTRA_LABELS rejects overriding __name__', () => {
  assert.throws(
    () => loadConfig(baseEnv({ REMOTE_WRITE_URL: 'http://localhost:8428/api/v1/write', REMOTE_WRITE_EXTRA_LABELS: '__name__=oops' })),
    ConfigError,
  );
});

test('REMOTE_WRITE_USERNAME and REMOTE_WRITE_PASSWORD must both be set or neither', () => {
  assert.throws(
    () => loadConfig(baseEnv({ REMOTE_WRITE_URL: 'http://localhost:8428/api/v1/write', REMOTE_WRITE_USERNAME: 'alice' })),
    ConfigError,
  );
});

test('WATER_TARIFF_MODE defaults to flat, with tariffTiers null', () => {
  const config = loadConfig(baseEnv());
  assert.equal(config.water?.tariffMode, 'flat');
  assert.equal(config.water?.tariffTiers, null);
});

test('WATER_TARIFF_MODE=tiered parses a full set of tiers', () => {
  // VAT_PERCENT explicitly zeroed so this test is about tier parsing, not
  // the VAT gross-up covered separately below.
  const config = loadConfig(
    baseEnv({
      WATER_TARIFF_MODE: 'tiered',
      WATER_PRICE_PER_CUBIC_METER: '10',
      WATER_TARIFF_EXCESS_PRICE_PER_CUBIC_METER: '20',
      WATER_TARIFF_HOUSEHOLD_SIZE: '4',
      WATER_TARIFF_ALLOWANCE_PER_PERSON_CUBIC_METERS: '3.5',
      VAT_PERCENT: '0',
    }),
  );
  assert.deepEqual(config.water?.tariffTiers, {
    normalRatePerCubicMeter: 10,
    excessRatePerCubicMeter: 20,
    householdSize: 4,
    allowancePerPersonCubicMeters: 3.5,
  });
});

test('WATER_TARIFF_MODE=tiered without WATER_PRICE_PER_CUBIC_METER is rejected', () => {
  assert.throws(
    () =>
      loadConfig(
        baseEnv({
          WATER_TARIFF_MODE: 'tiered',
          WATER_TARIFF_EXCESS_PRICE_PER_CUBIC_METER: '20',
          WATER_TARIFF_HOUSEHOLD_SIZE: '4',
          WATER_TARIFF_ALLOWANCE_PER_PERSON_CUBIC_METERS: '3.5',
        }),
      ),
    ConfigError,
  );
});

test('WATER_TARIFF_MODE=tiered without WATER_TARIFF_EXCESS_PRICE_PER_CUBIC_METER is rejected', () => {
  assert.throws(
    () =>
      loadConfig(
        baseEnv({
          WATER_TARIFF_MODE: 'tiered',
          WATER_PRICE_PER_CUBIC_METER: '10',
          WATER_TARIFF_HOUSEHOLD_SIZE: '4',
          WATER_TARIFF_ALLOWANCE_PER_PERSON_CUBIC_METERS: '3.5',
        }),
      ),
    ConfigError,
  );
});

test('WATER_TARIFF_MODE=tiered with a non-integer WATER_TARIFF_HOUSEHOLD_SIZE is rejected', () => {
  assert.throws(
    () =>
      loadConfig(
        baseEnv({
          WATER_TARIFF_MODE: 'tiered',
          WATER_PRICE_PER_CUBIC_METER: '10',
          WATER_TARIFF_EXCESS_PRICE_PER_CUBIC_METER: '20',
          WATER_TARIFF_HOUSEHOLD_SIZE: '4.5',
          WATER_TARIFF_ALLOWANCE_PER_PERSON_CUBIC_METERS: '3.5',
        }),
      ),
    ConfigError,
  );
});

test('WATER_TARIFF_MODE=tiered without WATER_TARIFF_ALLOWANCE_PER_PERSON_CUBIC_METERS is rejected', () => {
  assert.throws(
    () =>
      loadConfig(
        baseEnv({
          WATER_TARIFF_MODE: 'tiered',
          WATER_PRICE_PER_CUBIC_METER: '10',
          WATER_TARIFF_EXCESS_PRICE_PER_CUBIC_METER: '20',
          WATER_TARIFF_HOUSEHOLD_SIZE: '4',
        }),
      ),
    ConfigError,
  );
});

test('VAT_PERCENT defaults to 18% and grosses up WATER_PRICE_PER_CUBIC_METER', () => {
  const config = loadConfig(baseEnv({ WATER_PRICE_PER_CUBIC_METER: '10' }));
  assert.ok(Math.abs(config.water!.pricePerCubicMeter! - 11.8) < 1e-9);
});

test('VAT_PERCENT defaults to 18% and grosses up ELECTRICITY_PRICE_PER_KWH', () => {
  const config = loadConfig(baseEnv({ ELECTRICITY_ENABLED: 'true', ELECTRICITY_ID: '123456789', ELECTRICITY_PRICE_PER_KWH: '0.5383' }));
  assert.ok(Math.abs(config.electricity!.pricePerKwh! - 0.635194) < 1e-9);
  assert.equal(config.electricity!.vatPercent, 18);
});

test('VAT_PERCENT grosses up both the tiered water rates, from the same pre-VAT input', () => {
  const config = loadConfig(
    baseEnv({
      WATER_TARIFF_MODE: 'tiered',
      WATER_PRICE_PER_CUBIC_METER: '10',
      WATER_TARIFF_EXCESS_PRICE_PER_CUBIC_METER: '20',
      WATER_TARIFF_HOUSEHOLD_SIZE: '4',
      WATER_TARIFF_ALLOWANCE_PER_PERSON_CUBIC_METERS: '3.5',
      VAT_PERCENT: '18',
    }),
  );
  assert.ok(Math.abs(config.water!.tariffTiers!.normalRatePerCubicMeter - 11.8) < 1e-9);
  assert.ok(Math.abs(config.water!.tariffTiers!.excessRatePerCubicMeter - 23.6) < 1e-9);
});

test('VAT_PERCENT can be overridden to a custom rate', () => {
  const config = loadConfig(baseEnv({ WATER_PRICE_PER_CUBIC_METER: '10', VAT_PERCENT: '17' }));
  assert.ok(Math.abs(config.water!.pricePerCubicMeter! - 11.7) < 1e-9);
});

test('VAT_PERCENT=0 disables the gross-up entirely', () => {
  const config = loadConfig(baseEnv({ WATER_PRICE_PER_CUBIC_METER: '10', VAT_PERCENT: '0' }));
  assert.equal(config.water?.pricePerCubicMeter, 10);
});

test('VAT_PERCENT does not gross up an unset (null) price', () => {
  const config = loadConfig(baseEnv());
  assert.equal(config.water?.pricePerCubicMeter, null);
});

test('VAT_PERCENT rejects a negative value', () => {
  assert.throws(() => loadConfig(baseEnv({ VAT_PERCENT: '-5' })), ConfigError);
});

test('VAT_PERCENT rejects a non-numeric value', () => {
  assert.throws(() => loadConfig(baseEnv({ VAT_PERCENT: 'eighteen' })), ConfigError);
});

test('REMOTE_WRITE_BEARER_TOKEN is mutually exclusive with basic auth', () => {
  assert.throws(
    () =>
      loadConfig(
        baseEnv({
          REMOTE_WRITE_URL: 'http://localhost:8428/api/v1/write',
          REMOTE_WRITE_USERNAME: 'alice',
          REMOTE_WRITE_PASSWORD: 'secret',
          REMOTE_WRITE_BEARER_TOKEN: 'tok',
        }),
      ),
    ConfigError,
  );
});
