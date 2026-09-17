import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ElectricityConfig } from '../src/config.js';
import { ElectricityCollector } from '../src/electricity/collector.js';
import type { Logger } from '../src/logger.js';

const VALID_ID = '000000000';
const CONTRACT_ID = '900123456';
const METER_SERIAL = '12345678';
const METER_CODE = 'AB1';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function fakeIdToken(expiresInSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function fakeIec() {
  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    if (u.hostname !== 'iecapi.iec.co.il') {
      return new Response('', { status: 404 });
    }
    if (u.pathname === '/api/customer') {
      return json({ bpNumber: 'BP1' });
    }
    if (u.pathname === '/api/customer/contract/BP1') {
      return json({ contracts: [{ contractId: CONTRACT_ID }] });
    }
    if (u.pathname === `/api/Device/${CONTRACT_ID}`) {
      return json([{ deviceNumber: METER_SERIAL, deviceCode: METER_CODE }]);
    }
    if (u.pathname === `/api/Consumption/RemoteReadingRange/${CONTRACT_ID}`) {
      const body = JSON.parse(init.body as string) as { resolution: number };
      return body.resolution === 1
        ? json({ meterList: [{ periodConsumptions: [{ interval: '2026-08-19T00:00:00+00:00', consumption: 5 }] }] })
        : json({ meterList: [{ totalConsumptionForPeriod: 10 }] });
    }
    return new Response('', { status: 404 });
  };
}

function captureLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  const capture = (msg: string) => lines.push(msg);
  return { log: { debug: capture, info: capture, warn: capture, error: capture }, lines };
}

function makeConfig(tokenFile: string): ElectricityConfig {
  return { israeliId: VALID_ID, tokenFile, pollIntervalMs: 3_600_000, tariffMode: 'flat', pricePerKwh: null, tariffScheduleFile: null };
}

test('logs the backfill hint on a genuine first run, and not again once data has been recorded', async () => {
  globalThis.fetch = fakeIec() as typeof fetch;

  const dataDir = mkdtempSync(join(tmpdir(), 'electricity-collector-'));
  const tokenFile = join(dataDir, 'iec-token.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );

  const first = captureLog();
  const collectorA = new ElectricityCollector(makeConfig(tokenFile), dataDir, first.log);
  await collectorA.start();
  collectorA.stop();
  assert.ok(first.lines.some((line) => line.includes('First run detected')), 'must log the hint on a genuine first run');

  const second = captureLog();
  const collectorB = new ElectricityCollector(makeConfig(tokenFile), dataDir, second.log);
  await collectorB.start();
  collectorB.stop();
  assert.ok(!second.lines.some((line) => line.includes('First run detected')), 'must not log the hint again once data has been recorded');
});

test('keeps showing the hint across restarts if no poll has ever succeeded', async () => {
  globalThis.fetch = (async () => new Response('', { status: 500 })) as typeof fetch;

  const dataDir = mkdtempSync(join(tmpdir(), 'electricity-collector-'));
  const tokenFile = join(dataDir, 'iec-token.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );

  const first = captureLog();
  const collectorA = new ElectricityCollector(makeConfig(tokenFile), dataDir, first.log);
  await collectorA.start();
  collectorA.stop();
  assert.ok(first.lines.some((line) => line.includes('First run detected')));

  const second = captureLog();
  const collectorB = new ElectricityCollector(makeConfig(tokenFile), dataDir, second.log);
  await collectorB.start();
  collectorB.stop();
  assert.ok(second.lines.some((line) => line.includes('First run detected')), 'must still show the hint since no poll has ever succeeded');
});

test('retries persisting the flag on a later successful poll if an earlier write failed', async () => {
  globalThis.fetch = fakeIec() as typeof fetch;

  const workDir = mkdtempSync(join(tmpdir(), 'electricity-collector-'));
  const tokenFile = join(workDir, 'iec-token.json');
  writeFileSync(
    tokenFile,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: fakeIdToken(3600) }),
  );

  // A plain file where the collector's data directory should be — its
  // internal `mkdir(dirname(statePath), { recursive: true })` fails against
  // this, simulating a transient disk error on the first poll's state write.
  const brokenDataDir = join(workDir, 'not-a-directory');
  writeFileSync(brokenDataDir, 'x');

  const captured = captureLog();
  const config: ElectricityConfig = { israeliId: VALID_ID, tokenFile, pollIntervalMs: 30, tariffMode: 'flat', pricePerKwh: null, tariffScheduleFile: null };
  const collector = new ElectricityCollector(config, brokenDataDir, captured.log);

  await collector.start(); // fetches fine, but the state write fails
  assert.ok(captured.lines.some((line) => line.includes('First run detected')));

  // The disk becomes writable again before the next poll.
  unlinkSync(brokenDataDir);
  mkdirSync(brokenDataDir);
  await new Promise((resolve) => setTimeout(resolve, 200)); // let the scheduled next poll run
  collector.stop();

  const persisted = JSON.parse(await readFile(join(brokenDataDir, 'electricity-state.json'), 'utf8')) as { hasRecordedData?: boolean };
  assert.equal(persisted.hasRecordedData, true, 'a later successful poll must retry the write instead of leaving it stuck unpersisted');
});
