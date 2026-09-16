/**
 * Adapted from homebridge-read-your-meter-pro's test/smoke.mjs fake-portal
 * pattern (same author, MIT), scoped to the ported client rather than a full
 * plugin — no HomeKit/Homebridge shimming needed here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { enumerateWeekStarts, RateLimitedError, RymProClient, sumWeek, UnauthorizedError, weekStart } from '../src/water/rympro-client.js';

const METER_ID = 55123;
const METER_SERIAL = '000811515025';

const ymd = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const today = () => ymd(new Date());
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return ymd(d);
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

interface FakePortalState {
  loginCount: number;
  dailyPublished: Record<number, number | null>;
  rateLimit: { count: number; retryAfter?: number } | null;
}

function makeFakePortal(state: FakePortalState) {
  const dailyRows = (from: string, to: string) => {
    const rows: unknown[] = [];
    for (let offset = 10; offset >= 0; offset -= 1) {
      const date = daysAgo(offset);
      if (date < from || date > to) {
        continue;
      }
      const cons = state.dailyPublished[offset] ?? null;
      rows.push({ meterCount: METER_ID, consDate: `${date}T00:00:00`, cons });
    }
    return rows;
  };

  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (state.rateLimit && state.rateLimit.count > 0 && !url.includes('/login')) {
      state.rateLimit.count -= 1;
      const headers = state.rateLimit.retryAfter === undefined ? {} : { 'Retry-After': String(state.rateLimit.retryAfter) };
      return new Response('', { status: 429, headers });
    }

    const path = new URL(url).pathname;

    if (path === '/consumer/login') {
      const body = JSON.parse(init.body as string) as { pw: string; email: string; deviceId: string };
      state.loginCount += 1;
      if (body.pw !== 'correct-horse') {
        return json({ code: 5060, error: 'Invalid credentials' });
      }
      assert.ok(body.deviceId, 'login must send a deviceId');
      return json({ token: `token-${state.loginCount}` });
    }

    const headers = init.headers as Record<string, string> | undefined;
    if (!headers?.['x-access-token']?.startsWith('token-')) {
      return new Response('', { status: 401 });
    }

    if (path === '/consumption/last-read') {
      return json([{ meterCount: METER_ID, meterId: METER_SERIAL, read: 812.345 }]);
    }
    if (path.startsWith(`/consumption/daily/${METER_ID}/`)) {
      const [from, to] = path.split('/').slice(-2);
      return json(dailyRows(from!, to!));
    }
    if (path.startsWith(`/consumption/monthly/${METER_ID}/`)) {
      return json([{ meterCount: METER_ID, consDate: `${today().slice(0, 7)}-01T00:00:00`, cons: 14.2 }]);
    }
    if (path === `/consumption/forecast/${METER_ID}`) {
      return json({ estimatedConsumption: 21.8 });
    }
    return new Response('', { status: 404 });
  };
}

test('fetches a full snapshot on the happy path', async () => {
  const state: FakePortalState = { loginCount: 0, dailyPublished: { 0: 0.734, 1: 0.512, 2: 0.498, 3: 0.501 }, rateLimit: null };
  globalThis.fetch = makeFakePortal(state) as typeof fetch;

  const client = new RymProClient('aran@example.com', 'correct-horse', 'device-1');
  const [snapshot] = await client.fetchAll();

  assert.equal(snapshot!.total, 812.345);
  assert.equal(snapshot!.daily, 0.734);
  assert.equal(snapshot!.dailyDate, today());
  assert.equal(snapshot!.monthly, 14.2);
  assert.equal(snapshot!.forecast, 21.8);
  assert.equal(snapshot!.serial, METER_SERIAL);
});

test('falls back to the newest published day within the lookback window', async () => {
  // Real accounts sometimes leave both today and yesterday null for hours.
  const state: FakePortalState = { loginCount: 0, dailyPublished: { 0: null, 1: null, 2: 0.6, 3: 0.498 }, rateLimit: null };
  globalThis.fetch = makeFakePortal(state) as typeof fetch;

  const client = new RymProClient('aran@example.com', 'correct-horse', 'device-1');
  const [snapshot] = await client.fetchAll();

  assert.equal(snapshot!.daily, 0.6, 'must fall back to the newest published day, not sit at null');
  assert.equal(snapshot!.dailyDate, daysAgo(2));
});

test('a day older than the lookback window is treated as unpublished, not adopted', async () => {
  const state: FakePortalState = { loginCount: 0, dailyPublished: { 9: 0.9 }, rateLimit: null };
  globalThis.fetch = makeFakePortal(state) as typeof fetch;

  const client = new RymProClient('aran@example.com', 'correct-horse', 'device-1');
  const [snapshot] = await client.fetchAll();

  assert.equal(snapshot!.daily, null);
  assert.equal(snapshot!.dailyDate, null);
});

test('weekly total sums only the published days within the calendar week', async () => {
  const published = { 0: 0.1, 1: 0.2, 2: 0.3, 3: 0.4, 4: 0.5, 5: 0.6, 6: 0.7, 7: 9.9 };
  const state: FakePortalState = { loginCount: 0, dailyPublished: published, rateLimit: null };
  globalThis.fetch = makeFakePortal(state) as typeof fetch;

  const client = new RymProClient('aran@example.com', 'correct-horse', 'device-1', { weeklyWindow: 'sunday' });
  const [snapshot] = await client.fetchAll();

  const sinceStart = (new Date().getDay() - 0 + 7) % 7;
  const expected = Object.entries(published)
    .filter(([offset]) => Number(offset) <= sinceStart)
    .reduce((sum, [, v]) => sum + v, 0);

  assert.ok(Math.abs(snapshot!.weekly! - expected) < 0.001, `expected ${expected}, got ${snapshot!.weekly}`);
  assert.ok(snapshot!.weekly! < 3, 'the 9.9 eight days back must not leak into a calendar-week total');
});

test('rolling weekly window covers the last 7 days regardless of weekday', async () => {
  const published = { 0: 0.1, 1: 0.2, 2: 0.3, 3: 0.4, 4: 0.5, 5: 0.6, 6: 0.7, 7: 9.9 };
  const state: FakePortalState = { loginCount: 0, dailyPublished: published, rateLimit: null };
  globalThis.fetch = makeFakePortal(state) as typeof fetch;

  const client = new RymProClient('aran@example.com', 'correct-horse', 'device-1', { weeklyWindow: 'rolling' });
  const [snapshot] = await client.fetchAll();

  assert.ok(Math.abs(snapshot!.weekly! - 2.8) < 0.001, `expected 2.8, got ${snapshot!.weekly}`);
});

test('weekStart resolves Sunday and Monday windows across a DST boundary', () => {
  assert.equal(weekStart('2026-08-20', 0), '2026-08-16');
  assert.equal(weekStart('2026-08-20', 1), '2026-08-17');
  assert.equal(weekStart('2026-04-01', 0), '2026-03-29');
  assert.equal(weekStart('2026-04-01', 1), '2026-03-30');
});

test('rejected credentials throw InvalidCredentialsError distinct from a bare 401', async () => {
  const state: FakePortalState = { loginCount: 0, dailyPublished: {}, rateLimit: null };
  globalThis.fetch = makeFakePortal(state) as typeof fetch;

  const client = new RymProClient('aran@example.com', 'wrong-password', 'device-1');
  await assert.rejects(() => client.fetchAll(), (error: unknown) => {
    assert.ok(error instanceof UnauthorizedError);
    assert.equal(error.constructor.name, 'InvalidCredentialsError');
    return true;
  });
});

test('an expired token triggers exactly one silent re-login', async () => {
  const state: FakePortalState = { loginCount: 0, dailyPublished: { 0: 0.734 }, rateLimit: null };
  let expireNextGet = true;
  const basePortal = makeFakePortal(state);
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    if (expireNextGet && !url.includes('/login')) {
      expireNextGet = false;
      return new Response('', { status: 401 });
    }
    return basePortal(url, init);
  }) as typeof fetch;

  const client = new RymProClient('aran@example.com', 'correct-horse', 'device-1');
  client.setToken('stale-token');
  const [snapshot] = await client.fetchAll();

  assert.equal(state.loginCount, 1, 'exactly one re-login');
  assert.equal(snapshot!.total, 812.345, 'data still refreshed after re-auth');
});

test('a 429 is retried within the same call and eventually succeeds', async () => {
  const state: FakePortalState = { loginCount: 0, dailyPublished: { 0: 0.734 }, rateLimit: { count: 1, retryAfter: 0 } };
  globalThis.fetch = makeFakePortal(state) as typeof fetch;

  const client = new RymProClient('aran@example.com', 'correct-horse', 'device-1');
  const [snapshot] = await client.fetchAll();
  assert.equal(snapshot!.total, 812.345);
});

test('a 429 that never lets up gives up after the retry budget', async () => {
  const state: FakePortalState = { loginCount: 0, dailyPublished: {}, rateLimit: { count: 99, retryAfter: 0 } };
  globalThis.fetch = makeFakePortal(state) as typeof fetch;

  const client = new RymProClient('aran@example.com', 'correct-horse', 'device-1');
  await assert.rejects(() => client.fetchAll(), RateLimitedError);
});

test('dailyConsumptionRange is public and fetches an arbitrary range, newest first, excluding unpublished days', async () => {
  const state: FakePortalState = { loginCount: 0, dailyPublished: { 0: 0.5, 1: 0.6, 2: null }, rateLimit: null };
  globalThis.fetch = makeFakePortal(state) as typeof fetch;

  const client = new RymProClient('aran@example.com', 'correct-horse', 'device-1');
  await client.login();
  const rows = await client.dailyConsumptionRange(METER_ID, daysAgo(2), today());

  assert.deepEqual(
    rows.map((r) => r.date),
    [today(), daysAgo(1)],
  );
});

test('monthlyConsumption and listMeters are public and usable standalone, for the backfill CLI', async () => {
  const state: FakePortalState = { loginCount: 0, dailyPublished: {}, rateLimit: null };
  globalThis.fetch = makeFakePortal(state) as typeof fetch;

  const client = new RymProClient('aran@example.com', 'correct-horse', 'device-1');
  await client.login();

  const meters = await client.listMeters();
  assert.equal(meters[0]!.meterCount, METER_ID);

  const monthly = await client.monthlyConsumption(METER_ID, today());
  assert.equal(monthly, 14.2);
});

test('sumWeek sums only the days within the 7-day window starting at weekStartYmd', () => {
  const days = [
    { date: '2026-08-16', value: 1 },
    { date: '2026-08-17', value: 2 },
    { date: '2026-08-22', value: 3 }, // last day of the window (weekStart + 6)
    { date: '2026-08-23', value: 100 }, // next week — must not leak in
  ];
  const { value, counted } = sumWeek(days, '2026-08-16');
  assert.equal(value, 6);
  assert.equal(counted, 3);
});

test('sumWeek returns null when no day in the window is published', () => {
  assert.deepEqual(sumWeek([{ date: '2026-01-01', value: 5 }], '2026-02-01'), { value: null, counted: 0 });
});

test('enumerateWeekStarts lists every week window start between from and to', () => {
  assert.deepEqual(enumerateWeekStarts('2026-08-01', '2026-08-20', 'sunday'), ['2026-07-26', '2026-08-02', '2026-08-09', '2026-08-16']);
});

test('enumerateWeekStarts for a rolling window starts exactly at `from`', () => {
  assert.deepEqual(enumerateWeekStarts('2026-08-01', '2026-08-10', 'rolling'), ['2026-08-01', '2026-08-08']);
});
