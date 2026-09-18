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
