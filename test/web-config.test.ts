import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadWebConfig, WebConfigError } from '../src/web-config.js';

function configFile(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'web-config-'));
  const path = join(dir, 'web-config.yml');
  writeFileSync(path, yaml);
  return path;
}

test('a config with neither section set returns both as null', () => {
  const config = loadWebConfig(configFile('{}'));
  assert.equal(config.tls, null);
  assert.equal(config.basicAuthUsers, null);
});

test('reads tls cert/key file contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-config-'));
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  writeFileSync(certPath, 'fake-cert-contents');
  writeFileSync(keyPath, 'fake-key-contents');
  const path = join(dir, 'web-config.yml');
  writeFileSync(path, `tls_server_config:\n  cert_file: ${certPath}\n  key_file: ${keyPath}\n`);

  const config = loadWebConfig(path);
  assert.deepEqual(config.tls, { cert: 'fake-cert-contents', key: 'fake-key-contents' });
});

test('reads basic_auth_users as-is', () => {
  const config = loadWebConfig(
    configFile('basic_auth_users:\n  admin: "$2y$10$abcdefghijklmnopqrstuv"\n  viewer: "$2y$10$zzzzzzzzzzzzzzzzzzzzzz"\n'),
  );
  assert.deepEqual(config.basicAuthUsers, {
    admin: '$2y$10$abcdefghijklmnopqrstuv',
    viewer: '$2y$10$zzzzzzzzzzzzzzzzzzzzzz',
  });
});

test('rejects a tls_server_config missing key_file', () => {
  assert.throws(() => loadWebConfig(configFile('tls_server_config:\n  cert_file: /tmp/cert.pem\n')), WebConfigError);
});

test('rejects a tls_server_config pointing at a file that does not exist', () => {
  assert.throws(
    () => loadWebConfig(configFile('tls_server_config:\n  cert_file: /nonexistent/cert.pem\n  key_file: /nonexistent/key.pem\n')),
    WebConfigError,
  );
});

test('rejects a non-string basic_auth_users hash', () => {
  assert.throws(() => loadWebConfig(configFile('basic_auth_users:\n  admin: 12345\n')), WebConfigError);
});

test('rejects a basic_auth_users value that is not a mapping', () => {
  assert.throws(() => loadWebConfig(configFile('basic_auth_users: []\n')), WebConfigError);
  assert.throws(() => loadWebConfig(configFile('basic_auth_users: "admin"\n')), WebConfigError);
});

test('rejects a YAML document that is not a mapping', () => {
  assert.throws(() => loadWebConfig(configFile('- just\n- a\n- list\n')), WebConfigError);
});

test('rejects malformed YAML', () => {
  assert.throws(() => loadWebConfig(configFile('tls_server_config: [unterminated\n')), WebConfigError);
});

test('rejects a file that does not exist', () => {
  assert.throws(() => loadWebConfig('/nonexistent/web-config.yml'), WebConfigError);
});
