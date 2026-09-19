/**
 * Minimal client for the Read Your Meter Pro customer portal API.
 *
 * The endpoint layout and the 5060 error code were derived from `pyrympro`
 * (MIT, Copyright (c) 2022 On Freund) — see THIRD-PARTY-NOTICES.md. Ported
 * from homebridge-read-your-meter-pro's `src/rympro.ts` (same author, MIT),
 * with the HomeKit-facing pieces stripped out.
 */

import { monthAbbreviation } from '../time/day.js';

const BASE_URL = 'https://eu-customerportal-api.harmonyencoremdm.com';
const CONSUMER_URL = `${BASE_URL}/consumer`;
const CONSUMPTION_URL = `${BASE_URL}/consumption`;

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How many days before today the daily lookup is willing to accept a figure
 * from. The portal returns a row for each day from midnight but leaves `cons`
 * null until that day's reading has been processed, and the lag can be more
 * than a day or two. Seven days is enough to absorb that lag plus a missed
 * transmission, and is also the minimum that always spans the weekly window.
 */
const DAILY_LOOKBACK_DAYS = 7;

/** Length of the rolling weekly window, including today. */
const ROLLING_WEEK_DAYS = 7;

/** Minimum gap between two outbound requests, to stay under the portal's rate limit. */
const REQUEST_SPACING_MS = 250;

/** Delay before each retry of a rate-limited request, in order. */
const RATE_LIMIT_BACKOFF_MS = [2_000, 8_000, 30_000];

/** Longest `Retry-After` worth honouring inline; longer waits go to the next poll instead. */
const MAX_RETRY_AFTER_MS = 60_000;

export class CannotConnectError extends Error {}
export class UnauthorizedError extends Error {}
export class OperationError extends Error {}

/**
 * The portal rejected the email/password pair itself — login error 5060.
 * Distinct from a bare `UnauthorizedError` (a 401 from a data endpoint, which
 * can happen even with a token minted seconds earlier): a rejected password
 * must stop the poll loop to avoid tripping the portal's login lockout, while
 * a stray 401 is worth another poll.
 */
export class InvalidCredentialsError extends UnauthorizedError {}

/** HTTP 429. Subclasses OperationError so generic failure handling still applies. */
export class RateLimitedError extends OperationError {
  constructor(
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export type WeeklyWindow = 'sunday' | 'monday' | 'rolling';

export interface RymProClientOptions {
  weeklyWindow?: WeeklyWindow;
  onToken?: (token: string) => void;
  onRetry?: (message: string) => void;
  signal?: AbortSignal;
}

export interface MeterRead {
  meterCount: number;
  meterId?: string;
  read: number;
  [key: string]: unknown;
}

interface ConsumptionRow {
  consDate?: unknown;
  cons?: unknown;
  [key: string]: unknown;
}

export interface MeterSnapshot {
  meterCount: number;
  /** Cumulative reading, m³. */
  total: number;
  /** Consumption for the most recent published day, m³. Null if nothing published within the lookback window. */
  daily: number | null;
  /** Which day `daily` is for, YYYY-MM-DD. Null when `daily` is null. */
  dailyDate: string | null;
  /** Consumption over the configured weekly window, m³. Null when nothing is published yet. */
  weekly: number | null;
  weekStart: string;
  weeklyDaysCounted: number;
  weeklyDaysElapsed: number;
  /** Consumption so far this month, m³. Null if no reading yet. */
  monthly: number | null;
  /** Last calendar month's total consumption, m³. Null if unavailable. */
  previousMonth: number | null;
  /** Short name (e.g. "Jul") of the calendar month `previousMonth` covers. Null when `previousMonth` is null. */
  previousMonthLabel: string | null;
  /** Forecast consumption for the full month, m³. Null if unavailable. */
  forecast: number | null;
  /** Physical meter serial, when reported. */
  serial?: string;
}

export class RymProClient {
  private token: string | null = null;
  private readonly weeklyWindow: WeeklyWindow;
  private readonly onToken?: (token: string) => void;
  private readonly onRetry?: (message: string) => void;
  private readonly signal?: AbortSignal;
  private nextRequestAt = 0;

  constructor(
    private readonly email: string,
    private readonly password: string,
    private readonly deviceId: string,
    options: RymProClientOptions = {},
  ) {
    this.weeklyWindow = options.weeklyWindow ?? 'sunday';
    this.onToken = options.onToken;
    this.onRetry = options.onRetry;
    this.signal = options.signal;
  }

  setToken(token: string): void {
    this.token = token;
  }

  hasToken(): boolean {
    return this.token !== null;
  }

  async login(): Promise<string> {
    const json = await this.withRetry('/consumer/login', () => this.loginOnce());

    const token = json.token as string | undefined;
    const errorCode = json.code as number | undefined;
    const errorMessage = (json.error as string | undefined) ?? 'unknown error';

    if (errorCode === 5060) {
      throw new InvalidCredentialsError(errorMessage);
    }
    if (!token || errorCode) {
      throw new CannotConnectError(`code: ${errorCode}, error: ${errorMessage}`);
    }

    this.token = token;
    this.onToken?.(token);
    return token;
  }

  private loginOnce(): Promise<Record<string, unknown>> {
    return this.paced(async () => {
      let response: Response;
      try {
        response = await fetch(`${CONSUMER_URL}/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: this.email,
            pw: this.password,
            deviceId: this.deviceId,
          }),
          signal: this.requestSignal(),
        });
      } catch (error) {
        throw new CannotConnectError(describe(error));
      }
      if (response.status === 429) {
        throw rateLimited(response, '/consumer/login');
      }
      try {
        return (await response.json()) as Record<string, unknown>;
      } catch (error) {
        throw new CannotConnectError(describe(error));
      }
    });
  }

  /** Fetches everything the exporter needs, re-authenticating once if the stored token has expired. */
  async fetchAll(): Promise<MeterSnapshot[]> {
    if (!this.token) {
      await this.login();
    }
    try {
      return await this.fetchAllOnce();
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) {
        throw error;
      }
      this.token = null;
      await this.login();
      return this.fetchAllOnce();
    }
  }

  /** Every meter on the account, as reported by the portal's own meter list. */
  async listMeters(): Promise<MeterRead[]> {
    return this.get<MeterRead[]>(`${CONSUMPTION_URL}/last-read`);
  }

  private async fetchAllOnce(): Promise<MeterSnapshot[]> {
    const meters = await this.listMeters();
    const today = localDate();

    const snapshots: MeterSnapshot[] = [];
    for (const meter of meters) {
      const meterCount = meter.meterCount;
      // Issued one at a time: a burst of near-simultaneous requests is what
      // trips the portal's rate limiter, and a poll has an hour to complete.
      const published = await this.publishedDays(meterCount, today);
      const daily = published[0] ?? { value: null, date: null };
      const week = this.weeklyTotal(published, today);
      const monthly = await this.monthlyConsumption(meterCount, today);
      // Any date within last calendar month works — the endpoint keys off
      // the month the date falls in (see `monthlyConsumption`'s own doc
      // comment) — so the last day of the previous month is as good as any.
      const previousMonthDate = shiftDays(`${today.slice(0, 7)}-01`, -1);
      const previousMonth = await this.monthlyConsumption(meterCount, previousMonthDate);
      const forecast = await this.forecast(meterCount);

      snapshots.push({
        meterCount,
        total: toNumber(meter.read) ?? 0,
        daily: daily.value,
        dailyDate: daily.date,
        weekly: week.value,
        weekStart: week.start,
        weeklyDaysCounted: week.counted,
        weeklyDaysElapsed: week.elapsed,
        monthly,
        previousMonth,
        previousMonthLabel: previousMonth !== null ? monthAbbreviation(previousMonthDate) : null,
        forecast,
        serial: typeof meter.meterId === 'string' ? meter.meterId : undefined,
      });
    }
    return snapshots;
  }

  /**
   * Every day the portal has published in `[from, to]`, newest first. Empty
   * when it has published nothing in that range. Used both by the live
   * lookback (via `publishedDays`) and by the backfill CLI with a much wider
   * range.
   */
  async dailyConsumptionRange(meterCount: number, from: string, to: string): Promise<Array<{ value: number; date: string }>> {
    const rows = await this.get<ConsumptionRow[]>(`${CONSUMPTION_URL}/daily/${meterCount}/${from}/${to}`);
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows
      .map((row) => ({ value: toNumber(row?.cons), date: rowDate(row) }))
      .filter((row): row is { value: number; date: string } => row.value !== null && row.date !== null)
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  /** Every day in the live lookback window the portal has actually published, newest first. */
  private publishedDays(meterCount: number, today: string): Promise<Array<{ value: number; date: string }>> {
    return this.dailyConsumptionRange(meterCount, shiftDays(today, -DAILY_LOOKBACK_DAYS), today);
  }

  /** Consumption over the configured weekly window, summed from the already-fetched daily window. */
  private weeklyTotal(
    published: Array<{ value: number; date: string }>,
    today: string,
  ): { value: number | null; start: string; counted: number; elapsed: number } {
    const start =
      this.weeklyWindow === 'rolling'
        ? shiftDays(today, -(ROLLING_WEEK_DAYS - 1))
        : weekStart(today, this.weeklyWindow === 'monday' ? 1 : 0);
    const elapsed = daysBetween(start, today) + 1;
    const { value, counted } = sumWeek(published, start);
    return { value, start, counted, elapsed };
  }

  /**
   * Consumption for the calendar month containing `date`. The endpoint keys
   * off the month the range falls in, so a one-day range is all it needs —
   * call this once per calendar month when backfilling a wide range, rather
   * than assuming a multi-month `from`/`to` returns more than one month
   * (that behavior is unconfirmed against the live portal).
   */
  async monthlyConsumption(meterCount: number, date: string): Promise<number | null> {
    const rows = await this.get<ConsumptionRow[]>(`${CONSUMPTION_URL}/monthly/${meterCount}/${date}/${date}`);
    if (!Array.isArray(rows) || rows.length === 0) {
      return null;
    }
    return toNumber(rows[0]?.cons);
  }

  private async forecast(meterId: number): Promise<number | null> {
    try {
      const result = await this.get<{ estimatedConsumption?: unknown }>(
        `${CONSUMPTION_URL}/forecast/${meterId}`,
      );
      return toNumber(result?.estimatedConsumption);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw error;
      }
      // Forecast is the flakiest endpoint and the least important; a failure
      // here should not cost the whole poll.
      return null;
    }
  }

  private async get<T>(url: string): Promise<T> {
    const token = this.token;
    if (!token) {
      throw new OperationError('Not logged in');
    }
    return this.withRetry(redact(url), () => this.getOnce<T>(url, token));
  }

  private getOnce<T>(url: string, token: string): Promise<T> {
    return this.paced(async () => {
      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            'Content-Type': 'application/json',
            'x-access-token': token,
          },
          signal: this.requestSignal(),
        });
      } catch (error) {
        throw new OperationError(describe(error));
      }

      if (response.status === 401) {
        throw new UnauthorizedError(`401 from ${redact(url)}`);
      }
      if (response.status === 429) {
        throw rateLimited(response, redact(url));
      }
      if (!response.ok) {
        throw new OperationError(`HTTP ${response.status} from ${redact(url)}`);
      }
      try {
        return (await response.json()) as T;
      } catch (error) {
        throw new OperationError(`Malformed JSON from ${redact(url)}: ${describe(error)}`);
      }
    });
  }

  /** Runs a request, retrying only on HTTP 429. */
  private async withRetry<T>(label: string, send: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await send();
      } catch (error) {
        if (!(error instanceof RateLimitedError)) {
          throw error;
        }
        const delay = backoffFor(error, attempt);
        if (delay === null) {
          throw error;
        }
        this.onRetry?.(
          `Rate limited on ${label}; waiting ${(delay / 1000).toFixed(1)}s before retry ` +
            `${attempt + 1} of ${RATE_LIMIT_BACKOFF_MS.length}.`,
        );
        await sleep(delay, this.signal);
      }
    }
  }

  /** Holds a request back until the spacing since the previous one has elapsed. */
  private async paced<T>(send: () => Promise<T>): Promise<T> {
    const wait = this.nextRequestAt - Date.now();
    if (wait > 0) {
      await sleep(wait, this.signal);
    }
    try {
      return await send();
    } finally {
      this.nextRequestAt = Date.now() + REQUEST_SPACING_MS;
    }
  }

  private requestSignal(): AbortSignal {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return this.signal ? AbortSignal.any([timeout, this.signal]) : timeout;
  }
}

function rateLimited(response: Response, label: string): RateLimitedError {
  return new RateLimitedError(
    `HTTP 429 from ${label}`,
    parseRetryAfter(response.headers.get('retry-after')),
  );
}

function backoffFor(error: RateLimitedError, attempt: number): number | null {
  if (attempt >= RATE_LIMIT_BACKOFF_MS.length) {
    return null;
  }
  const asked = error.retryAfterMs;
  if (asked !== null) {
    return asked <= MAX_RETRY_AFTER_MS ? asked + Math.random() * 1_000 : null;
  }
  const rung = RATE_LIMIT_BACKOFF_MS[attempt] ?? RATE_LIMIT_BACKOFF_MS.at(-1)!;
  return rung * (0.75 + Math.random() * 0.5);
}

function parseRetryAfter(header: string | null): number | null {
  const value = header?.trim();
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1_000);
  }
  const when = Date.parse(value);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OperationError('shutting down'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new OperationError('shutting down'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** YYYY-MM-DD in the host's local timezone — the meter reports on local days. */
function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function rowDate(row: ConsumptionRow | undefined): string | null {
  const value = row?.consDate;
  if (typeof value !== 'string') {
    return null;
  }
  const date = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function shiftDays(date: string, days: number): string {
  const parts = date.split('-').map(Number);
  const year = parts[0]!;
  const month = parts[1]!;
  const day = parts[2]!;
  const shifted = new Date(year, month - 1, day + days, 12);
  return localDate(shifted);
}

function noon(date: string): Date {
  const parts = date.split('-').map(Number);
  const year = parts[0]!;
  const month = parts[1]!;
  const day = parts[2]!;
  return new Date(year, month - 1, day, 12);
}

/** First day of the calendar week containing `date`. `startsOn` is 0 for Sunday. */
export function weekStart(date: string, startsOn: 0 | 1): string {
  const offset = (noon(date).getDay() - startsOn + 7) % 7;
  return shiftDays(date, -offset);
}

/** Sums the given days that fall within the 7-day window starting at `weekStartYmd`. */
export function sumWeek(days: Array<{ value: number; date: string }>, weekStartYmd: string): { value: number | null; counted: number } {
  const weekEnd = shiftDays(weekStartYmd, ROLLING_WEEK_DAYS - 1);
  const inWeek = days.filter((day) => day.date >= weekStartYmd && day.date <= weekEnd);
  if (inWeek.length === 0) {
    return { value: null, counted: 0 };
  }
  return { value: inWeek.reduce((sum, day) => sum + day.value, 0), counted: inWeek.length };
}

/**
 * Every week-window start (per `window`) between `from` and `to`, inclusive.
 * Used by the backfill CLI to bucket a wide daily range the same way the
 * live gauge buckets its own lookback window.
 */
export function enumerateWeekStarts(from: string, to: string, window: WeeklyWindow): string[] {
  const starts: string[] = [];
  let cursor = window === 'rolling' ? from : weekStart(from, window === 'monday' ? 1 : 0);
  while (cursor <= to) {
    starts.push(cursor);
    cursor = shiftDays(cursor, ROLLING_WEEK_DAYS);
  }
  return starts;
}

function daysBetween(from: string, to: string): number {
  return Math.round((noon(to).getTime() - noon(from).getTime()) / 86_400_000);
}

function toNumber(value: unknown): number | null {
  // `Number(null)` is 0 and `Number('')` is 0, so both must be rejected before
  // the coercion: the portal uses null for "not published yet".
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function redact(url: string): string {
  return url.replace(BASE_URL, '');
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' ? 'request timed out' : error.message;
  }
  return String(error);
}
