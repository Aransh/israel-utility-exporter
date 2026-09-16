import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { IecClient, isValidIsraeliId, ReadingResolution } from '../src/electricity/iec-client.js';

// A real, checksum-valid Israeli ID pattern (9 digits, Luhn-like check used by
// the Population Authority). 000000000 is the canonical "always valid" test ID.
const VALID_ID = '000000000';

test('isValidIsraeliId validates the checksum', () => {
  assert.equal(isValidIsraeliId(VALID_ID), true);
  assert.equal(isValidIsraeliId('123456789'), false);
  assert.equal(isValidIsraeliId('12345678'), false, 'too short');
  assert.equal(isValidIsraeliId('abcdefghi'), false, 'not numeric');
});

function fakeIdToken(expiresInSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const CONTRACT_ID = '900123456';
const METER_SERIAL = '12345678';
const METER_CODE = 'AB1';

interface FakeIecState {
  idToken: string;
  refreshCount: number;
}

function makeFakeIec(state: FakeIecState) {
  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);

    if (u.hostname.includes('okta') && u.pathname === '/oauth2/default/v1/token') {
      const body = new URLSearchParams(init.body as string);
      if (body.get('grant_type') === 'refresh_token') {
        state.refreshCount += 1;
        state.idToken = fakeIdToken(3600);
        return json({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: state.idToken });
      }
      return json({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: state.idToken });
    }

    if (u.hostname === 'iecapi.iec.co.il' && u.pathname === '/api/customer') {
      return json({ bpNumber: 'BP1' });
    }
    if (u.hostname === 'iecapi.iec.co.il' && u.pathname === `/api/customer/contract/BP1`) {
      return json({ contracts: [{ contractId: CONTRACT_ID, contractNumber: CONTRACT_ID, address: 'Rothschild 1, Tel Aviv' }] });
    }
    if (u.hostname === 'iecapi.iec.co.il' && u.pathname === `/api/Device/${CONTRACT_ID}`) {
      return json([{ deviceNumber: METER_SERIAL, deviceCode: METER_CODE }]);
    }
    if (u.hostname === 'iecapi.iec.co.il' && u.pathname === `/api/Consumption/RemoteReadingRange/${CONTRACT_ID}`) {
      const body = JSON.parse(init.body as string) as { resolution: number };
      if (body.resolution === ReadingResolution.DAILY) {
        return json({
          meterList: [
            {
              futureConsumptionInfo: { totalImport: 1234.5 },
              periodConsumptions: [
                { interval: '2026-08-18T00:00:00+00:00', consumption: 12.3 },
                { interval: '2026-08-19T00:00:00+00:00', consumption: 15.1 },
              ],
            },
          ],
        });
      }
      return json({
        meterList: [{ totalConsumptionForPeriod: 210.7, futureConsumptionInfo: { totalImport: 1234.5 } }],
      });
    }

    return new Response('', { status: 404 });
  };
}

interface FakeOktaFactor {
  id: string;
  factorType: string;
  profile?: Record<string, unknown>;
}

function makeFakeOktaLogin(factors: FakeOktaFactor[]) {
  return async (url: string): Promise<Response> => {
    const u = new URL(url);
    if (u.pathname === '/api/v1/authn') {
      return json({ stateToken: 'state-token', _embedded: { factors } });
    }
    const verifyMatch = /^\/api\/v1\/authn\/factors\/(.+)\/verify$/.exec(u.pathname);
    if (verifyMatch) {
      const factor = factors.find((f) => f.id === verifyMatch[1]);
      return json({ _embedded: { factor } });
    }
    return new Response('', { status: 404 });
  };
}

test('loginWithId reports "sms" for a genuine sms factor', async () => {
  globalThis.fetch = makeFakeOktaLogin([{ id: 'f1', factorType: 'sms', profile: { phoneNumber: '+972501234567' } }]) as typeof fetch;
  assert.equal(await new IecClient(VALID_ID).loginWithId(), 'sms');
});

test('loginWithId reports a genuine external "email" factor as email', async () => {
  globalThis.fetch = makeFakeOktaLogin([{ id: 'f1', factorType: 'email', profile: { email: 'user@example.com' } }]) as typeof fetch;
  assert.equal(await new IecClient(VALID_ID).loginWithId(), 'email');
});

test('loginWithId normalizes an "email" factor pointed at IEC\'s SMS gateway to "sms"', async () => {
  // IEC registers some accounts' OTP factor as Okta type "email" but pointed
  // at their own email-to-SMS gateway — the code really arrives as a text.
  globalThis.fetch = makeFakeOktaLogin([{ id: 'f1', factorType: 'email', profile: { email: 'M...h@sns.iec.co.il' } }]) as typeof fetch;
  assert.equal(await new IecClient(VALID_ID).loginWithId(), 'sms');
});

test('loads a token from file, proactively refreshing when close to expiry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iec-'));
  const path = join(dir, 'token.json');
  const state: FakeIecState = { idToken: fakeIdToken(60), refreshCount: 0 }; // expires in 60s: inside the refresh margin
  const fs = await import('node:fs/promises');
  await fs.writeFile(
    path,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 60, scope: 'openid', id_token: state.idToken }),
  );

  globalThis.fetch = makeFakeIec(state) as typeof fetch;
  const client = new IecClient(VALID_ID);
  await client.loadTokenFromFile(path);

  assert.equal(state.refreshCount, 1, 'a token inside the refresh margin must be refreshed on load');
  const expiry = client.tokenExpiresAt();
  assert.ok(expiry !== null && expiry > Math.floor(Date.now() / 1000) + 1000, 'the refreshed token must expire further out');
});

test('fetchSnapshot returns the newest daily figure, the monthly total and the cumulative reading', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iec-'));
  const path = join(dir, 'token.json');
  const state: FakeIecState = { idToken: fakeIdToken(3600), refreshCount: 0 };
  const fs = await import('node:fs/promises');
  await fs.writeFile(
    path,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: state.idToken }),
  );

  globalThis.fetch = makeFakeIec(state) as typeof fetch;
  const client = new IecClient(VALID_ID);
  await client.loadTokenFromFile(path);

  const snapshot = await client.fetchSnapshot();
  assert.equal(snapshot.contractId, CONTRACT_ID);
  assert.equal(snapshot.address, 'Rothschild 1, Tel Aviv');
  assert.equal(snapshot.meterReadingKwh, 1234.5);
  assert.equal(snapshot.daily, 15.1, 'must pick the newest dated period, not the first in the array');
  assert.equal(snapshot.dailyDate, '2026-08-19');
  assert.equal(snapshot.monthly, 210.7);
});

test('saveTokenToFile round-trips through loadTokenFromFile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iec-'));
  const path = join(dir, 'sub', 'token.json');
  const state: FakeIecState = { idToken: fakeIdToken(3600), refreshCount: 0 };
  globalThis.fetch = makeFakeIec(state) as typeof fetch;

  const writer = new IecClient(VALID_ID);
  // Simulate a completed login by loading a token from an in-memory source
  // via a temp file, then saving it back out to a nested (not-yet-existing) directory.
  const seedPath = join(dir, 'seed.json');
  const fs = await import('node:fs/promises');
  await fs.writeFile(
    seedPath,
    JSON.stringify({ access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 3600, scope: 'openid', id_token: state.idToken }),
  );
  await writer.loadTokenFromFile(seedPath);
  await writer.saveTokenToFile(path);

  const saved = JSON.parse(readFileSync(path, 'utf8')) as { id_token: string };
  assert.equal(saved.id_token, state.idToken);
});
