import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { get as httpGet, type IncomingHttpHeaders } from 'node:http';
import { get as httpsGet } from 'node:https';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import bcrypt from 'bcryptjs';

import type { Logger } from '../src/logger.js';
import { startServer } from '../src/server.js';
import type { WebConfig } from '../src/web-config.js';
import { loadWebConfig } from '../src/web-config.js';

const SILENT_LOG: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

interface Response {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function request(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith('https:') ? httpsGet : httpGet;
    const req = getter(url, { headers, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

function basicAuthHeader(user: string, password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` };
}

async function withServer<T>(webConfig: WebConfig | null, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = startServer(0, SILENT_LOG, webConfig);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a network address');
  }
  const scheme = webConfig?.tls ? 'https' : 'http';
  try {
    return await run(`${scheme}://localhost:${address.port}`);
  } finally {
    server.close();
  }
}

test('serves /healthz and /metrics without auth when no web config is set', async () => {
  await withServer(null, async (baseUrl) => {
    const healthz = await request(`${baseUrl}/healthz`);
    assert.equal(healthz.status, 200);

    const metrics = await request(`${baseUrl}/metrics`);
    assert.equal(metrics.status, 200);

    const notFound = await request(`${baseUrl}/nope`);
    assert.equal(notFound.status, 404);
  });
});

test('basic auth: /healthz stays open, /metrics and / require valid credentials', async () => {
  const hash = bcrypt.hashSync('correct-password', 4);
  const webConfig: WebConfig = { tls: null, basicAuthUsers: { admin: hash } };

  await withServer(webConfig, async (baseUrl) => {
    const healthz = await request(`${baseUrl}/healthz`);
    assert.equal(healthz.status, 200, '/healthz must never require auth');

    const noAuth = await request(`${baseUrl}/metrics`);
    assert.equal(noAuth.status, 401);
    assert.match(String(noAuth.headers['www-authenticate']), /Basic/);

    const wrongPassword = await request(`${baseUrl}/metrics`, basicAuthHeader('admin', 'wrong'));
    assert.equal(wrongPassword.status, 401);

    const unknownUser = await request(`${baseUrl}/metrics`, basicAuthHeader('nobody', 'correct-password'));
    assert.equal(unknownUser.status, 401);

    const authorized = await request(`${baseUrl}/metrics`, basicAuthHeader('admin', 'correct-password'));
    assert.equal(authorized.status, 200);

    const rootAuthorized = await request(baseUrl, basicAuthHeader('admin', 'correct-password'));
    assert.equal(rootAuthorized.status, 200);
  });
});

test('tls: serves everything over https, /healthz still without auth', { skip: !hasOpenssl() }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'server-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-nodes',
    '-subj',
    '/CN=localhost',
  ]);
  const configPath = join(dir, 'web-config.yml');
  execFileSync('sh', ['-c', `printf 'tls_server_config:\\n  cert_file: %s\\n  key_file: %s\\n' "$0" "$1" > "$2"`, certPath, keyPath, configPath]);
  const webConfig = loadWebConfig(configPath);

  await withServer(webConfig, async (baseUrl) => {
    assert.ok(baseUrl.startsWith('https://'));
    const healthz = await request(`${baseUrl}/healthz`);
    assert.equal(healthz.status, 200);
  });
});

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version']);
    return true;
  } catch {
    return false;
  }
}
