/**
 * Client for the Israel Electric Company (IEC) consumer API.
 *
 * Ported from homebridge-iec-electricity's `src/iec-client.ts` (Shay Shahar,
 * Apache-2.0), itself a TypeScript port of `py-iec-api` (Guy Khmelnitsky,
 * Apache-2.0) — see THIRD-PARTY-NOTICES.md. The Okta PKCE/OTP login flow, the
 * endpoint layout and the `ReadingResolution` values (DAILY=1, WEEKLY=2,
 * MONTHLY=3 — confirmed against `py-iec-api`'s `remote_reading.py`) all come
 * from that lineage. This port adds a DAILY-resolution fetch alongside the
 * MONTHLY one the source plugin used, and drops the verbose per-request
 * console logging in favour of an injected logger.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const APP_CLIENT_ID = process.env.IEC_CLIENT_ID || '0oaqf6zr7yEcQZqqt2p7';
const CODE_CHALLENGE_METHOD = 'S256';
const APP_REDIRECT_URI = process.env.IEC_REDIRECT_URI || 'com.iecrn:/';
const IEC_OKTA_BASE_URL = process.env.IEC_OKTA_BASE_URL || 'https://iec-ext.okta.com';
const IEC_API_BASE_URL = 'https://iecapi.iec.co.il/api/';

const GET_CONSUMER_URL = `${IEC_API_BASE_URL}customer`;
const GET_CONTRACTS_URL = `${IEC_API_BASE_URL}customer/contract/{bp_number}`;
const GET_DEVICES_URL = `${IEC_API_BASE_URL}Device/{contract_id}`;
const GET_REMOTE_READING_URL = `${IEC_API_BASE_URL}Consumption/RemoteReadingRange/{contract_id}`;

// IEC registers some accounts' OTP factor as Okta type "email", but pointed
// at this internal domain rather than a real inbox — it's IEC's own
// email-to-SMS gateway, so the code actually arrives as a text message.
const IEC_SMS_GATEWAY_EMAIL_DOMAIN = 'sns.iec.co.il';

/** Token expires proactively refreshed once fewer than this many seconds remain. */
const REFRESH_MARGIN_SECONDS = 300;

/** How many days back the daily lookup asks for, absorbing IEC's own 1-2 day publication lag. */
export const DAILY_LOOKBACK_DAYS = 7;

function iecHeaders(idToken: string): Record<string, string> {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en,he;q=0.9',
    authorization: `Bearer ${idToken}`,
    origin: 'https://www.iec.co.il',
    referer: 'https://www.iec.co.il/',
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'x-iec-idt': '1',
    'x-iec-webview': '1',
  };
}

/** Matches py-iec-api's `ReadingResolution` IntEnum exactly. */
export enum ReadingResolution {
  DAILY = 1,
  WEEKLY = 2,
  MONTHLY = 3,
}

export interface JWT {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  id_token: string;
}

export interface Customer {
  bpNumber?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}

export interface Contract {
  contractId: string;
  contractNumber?: string;
  address?: string;
}

interface Device {
  deviceNumber?: string;
  deviceCode?: string;
  serialNumber?: string;
}

export interface PeriodConsumption {
  /** ISO date/time the period covers. */
  interval: string;
  /** kWh for that period. */
  consumption: number;
}

export interface ConsumptionResult {
  /** One row per period the endpoint reports for the requested resolution. */
  periods: PeriodConsumption[];
  /**
   * Cumulative meter reading as of *now*, kWh — the figure IEC's own site
   * calls "last reading". Confirmed against a live account to be identical
   * regardless of which historical period was requested — it always
   * reflects today, not the requested period — so it's only meaningful for
   * the live snapshot, never as a historical value. See `periodEndReading`
   * for that.
   */
  totalImport: number | null;
  /** Total for the requested period as computed server-side (used for the monthly figure). */
  totalForPeriod: number | null;
  /**
   * Cumulative meter reading as of `periodEndReadingDate`, kWh — a genuine
   * dated historical reading (distinct from `totalImport`, which is always
   * "now"). Confirmed against a live account: querying two different past
   * months returns two different values here, each dated to that month's
   * last day.
   */
  periodEndReading: number | null;
  /** YYYY-MM-DD `periodEndReading` is as of. Null when `periodEndReading` is null. */
  periodEndReadingDate: string | null;
}

export class IECError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
    this.name = 'IECError';
  }
}

export class IECLoginError extends IECError {
  constructor(code: number, message: string) {
    super(code, message);
    this.name = 'IECLoginError';
  }
}

function generatePKCEPair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge: hash };
}

function generateState(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/** Validates an Israeli ID (Teudat Zehut) checksum. */
export function isValidIsraeliId(id: string | number): boolean {
  const idStr = String(id);
  if (!/^\d{9}$/.test(idStr)) {
    return false;
  }
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    let digit = Number.parseInt(idStr[i]!, 10);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export interface IecClientOptions {
  log?: (message: string) => void;
}

export class IecClient {
  private stateToken?: string;
  private factorId?: string;
  private token?: JWT;
  private bpNumber?: string;
  private contractId?: string;
  private readonly log: (message: string) => void;

  constructor(
    private readonly userId: string,
    options: IecClientOptions = {},
  ) {
    if (!isValidIsraeliId(userId)) {
      throw new Error('User ID must be a valid Israeli ID');
    }
    this.log = options.log ?? (() => {});
  }

  // ------------------------------------------------------------ login (CLI only)

  /**
   * First login step: sends an OTP to the user's registered phone/email.
   * Returns the channel to tell the user ("sms", "email", ...) — normalized
   * against IEC_SMS_GATEWAY_EMAIL_DOMAIN, since an Okta "email" factor there
   * really means "sms" to a human.
   */
  async loginWithId(): Promise<string> {
    const authnResponse = await fetch(`${IEC_OKTA_BASE_URL}/api/v1/authn`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ username: `${this.userId}@iec.co.il` }),
    });
    if (!authnResponse.ok) {
      throw new IECLoginError(authnResponse.status, `Failed to initiate login: ${authnResponse.statusText}`);
    }
    const authnData = (await authnResponse.json()) as {
      stateToken?: string;
      _embedded?: { factors?: Array<{ id?: string; factorType?: string; profile?: Record<string, unknown> }> };
    };
    this.stateToken = authnData.stateToken;
    const factors = authnData._embedded?.factors ?? [];
    const factor = factors[0];
    if (!factor?.id) {
      throw new IECLoginError(-1, 'No authentication factors found for this ID');
    }
    this.factorId = factor.id;

    const otpResponse = await fetch(`${IEC_OKTA_BASE_URL}/api/v1/authn/factors/${this.factorId}/verify`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ stateToken: this.stateToken }),
    });
    if (!otpResponse.ok) {
      const text = await otpResponse.text().catch(() => '');
      throw new IECLoginError(otpResponse.status, `Failed to send OTP: ${otpResponse.statusText}. ${text.slice(0, 200)}`);
    }
    const otpData = (await otpResponse.json()) as {
      _embedded?: { factor?: { factorType?: string; profile?: Record<string, unknown> } };
    };
    const verifiedFactor = otpData._embedded?.factor;
    const factorType = verifiedFactor?.factorType ?? factor.factorType ?? 'unknown';
    const profile = verifiedFactor?.profile ?? factor.profile ?? {};
    const destination = typeof profile.email === 'string' ? profile.email : typeof profile.phoneNumber === 'string' ? profile.phoneNumber : null;
    if (factorType === 'email' && destination?.toLowerCase().endsWith(`@${IEC_SMS_GATEWAY_EMAIL_DOMAIN}`)) {
      this.log(`Factor is Okta type "email" but the address (${destination}) is IEC's SMS gateway — reporting it as sms.`);
      return 'sms';
    }
    return factorType;
  }

  /** Second login step: verifies the OTP code and completes the OAuth exchange. */
  async verifyOtp(otpCode: string): Promise<void> {
    if (!this.factorId || !this.stateToken) {
      throw new IECLoginError(-1, "OTP wasn't requested yet — call loginWithId() first");
    }

    const verifyResponse = await fetch(`${IEC_OKTA_BASE_URL}/api/v1/authn/factors/${this.factorId}/verify`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ stateToken: this.stateToken, passCode: String(otpCode) }),
    });
    if (!verifyResponse.ok) {
      const text = await verifyResponse.text().catch(() => '');
      throw new IECLoginError(verifyResponse.status, `OTP verification failed: ${verifyResponse.statusText}. ${text.slice(0, 200)}`);
    }
    const verifyData = (await verifyResponse.json()) as {
      sessionToken?: string;
      status?: string;
      errorSummary?: string;
    };
    if (verifyData.status && !['SUCCESS', 'MFA_CHALLENGE'].includes(verifyData.status)) {
      throw new IECLoginError(-1, `OTP verification failed: ${verifyData.status} ${verifyData.errorSummary ?? ''}`.trim());
    }
    const sessionToken = verifyData.sessionToken;
    if (!sessionToken) {
      throw new IECLoginError(-1, 'OTP verification returned no session token');
    }

    const { codeVerifier, codeChallenge } = generatePKCEPair();
    const authorizeUrl =
      `${IEC_OKTA_BASE_URL}/oauth2/default/v1/authorize?` +
      `client_id=${APP_CLIENT_ID}&response_type=id_token+code&response_mode=form_post&` +
      `scope=openid%20email%20profile%20offline_access&redirect_uri=${encodeURIComponent(APP_REDIRECT_URI)}&` +
      `state=${generateState()}&nonce=abc123&code_challenge_method=${CODE_CHALLENGE_METHOD}&` +
      `sessionToken=${sessionToken}&code_challenge=${codeChallenge}`;

    const authorizeResponse = await fetch(authorizeUrl, { method: 'GET', redirect: 'manual' });
    if (authorizeResponse.status !== 200 && authorizeResponse.status !== 302) {
      throw new IECLoginError(authorizeResponse.status, `Authorization failed: ${authorizeResponse.statusText}`);
    }
    const responseText = await authorizeResponse.text();
    const codeMatch = responseText.match(/name=['"]code['"]\s+value=['"]([^'"]+)['"]/);
    if (!codeMatch) {
      throw new IECLoginError(-1, 'Failed to extract authorization code from Okta response');
    }

    const tokenResponse = await fetch(`${IEC_OKTA_BASE_URL}/oauth2/default/v1/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: APP_CLIENT_ID,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: APP_REDIRECT_URI,
        code: codeMatch[1]!,
      }),
    });
    if (!tokenResponse.ok) {
      throw new IECLoginError(tokenResponse.status, `Failed to get access token: ${tokenResponse.statusText}`);
    }
    const tokenData = (await tokenResponse.json()) as JWT;
    if (!tokenData.access_token || !tokenData.id_token) {
      throw new IECLoginError(-1, 'Invalid token response: missing access_token or id_token');
    }
    this.token = tokenData;
  }

  // ------------------------------------------------------------------ token state

  async loadTokenFromFile(filePath: string): Promise<void> {
    const contents = await readFile(filePath, 'utf-8');
    this.token = JSON.parse(contents) as JWT;
    await this.checkToken();
  }

  async saveTokenToFile(filePath: string): Promise<void> {
    if (!this.token) {
      throw new IECLoginError(-1, 'No token to save');
    }
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(this.token, null, 2), { mode: 0o600 });
  }

  /** Seconds since the epoch at which the current id_token expires, or null if not logged in. */
  tokenExpiresAt(): number | null {
    if (!this.token) {
      return null;
    }
    return decodeExpiry(this.token.id_token);
  }

  private async checkToken(): Promise<void> {
    if (!this.token) {
      throw new IECLoginError(-1, 'No token available');
    }
    const exp = decodeExpiry(this.token.id_token);
    const now = Math.floor(Date.now() / 1000);
    if (exp !== null && exp - now < REFRESH_MARGIN_SECONDS) {
      await this.refreshToken();
    }
  }

  private async refreshToken(): Promise<void> {
    if (!this.token?.refresh_token) {
      throw new IECLoginError(-1, 'No refresh token available — re-run the login CLI');
    }
    const response = await fetch(`${IEC_OKTA_BASE_URL}/oauth2/default/v1/token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: APP_CLIENT_ID,
        redirect_uri: APP_REDIRECT_URI,
        refresh_token: this.token.refresh_token,
        grant_type: 'refresh_token',
        scope: 'openid email profile offline_access',
      }),
    });
    if (!response.ok) {
      throw new IECLoginError(response.status, `Token refresh failed: ${response.statusText} — the refresh token may have expired; re-run the login CLI`);
    }
    this.token = (await response.json()) as JWT;
  }

  private authHeaders(): Record<string, string> {
    if (!this.token) {
      throw new IECLoginError(-1, 'Not logged in');
    }
    return iecHeaders(this.token.id_token);
  }

  // ------------------------------------------------------------------ data

  async getCustomer(): Promise<Customer> {
    await this.checkToken();
    const response = await fetch(GET_CONSUMER_URL, { headers: this.authHeaders() });
    if (!response.ok) {
      throw new IECError(response.status, `Failed to get customer: ${response.statusText}`);
    }
    const customer = (await response.json()) as Customer;
    this.log(`[IEC] customer: ${JSON.stringify(customer)}`);
    if (!customer.bpNumber) {
      throw new IECError(-1, 'Customer response missing bpNumber');
    }
    this.bpNumber = customer.bpNumber;
    return customer;
  }

  async getContracts(bpNumber?: string): Promise<Contract[]> {
    await this.checkToken();
    const bp = bpNumber ?? this.bpNumber;
    if (!bp) {
      throw new Error('BP number must be provided');
    }
    const url = GET_CONTRACTS_URL.replace('{bp_number}', bp);
    const response = await fetch(url, { headers: this.authHeaders() });
    if (!response.ok) {
      throw new IECError(response.status, `Failed to get contracts: ${response.statusText}`);
    }
    const raw = (await response.json()) as { contracts?: Contract[]; data?: { contracts?: Contract[] } };
    const contracts = raw.contracts ?? raw.data?.contracts ?? [];
    this.log(`[IEC] contracts: ${JSON.stringify(contracts)}`);
    if (contracts[0]) {
      this.contractId = contracts[0].contractId;
    }
    return contracts;
  }

  private async getDevices(contractId: string): Promise<Device[]> {
    await this.checkToken();
    const url = GET_DEVICES_URL.replace('{contract_id}', contractId);
    const response = await fetch(url, { headers: this.authHeaders() });
    if (!response.ok) {
      throw new IECError(response.status, `Failed to get devices: ${response.statusText}`);
    }
    const raw = await response.json();
    const devices = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
    this.log(`[IEC] devices: ${JSON.stringify(devices)}`);
    return devices.map((d) => ({
      deviceNumber: d.deviceNumber as string | undefined,
      deviceCode: d.deviceCode as string | undefined,
      serialNumber: (d.serialNumber ?? d.deviceNumber) as string | undefined,
    }));
  }

  /**
   * Fetches consumption at a given resolution. `fromDate` is YYYY-MM-DD; for
   * DAILY it should be a lookback window start, for MONTHLY the first of the
   * target month — matching what IEC's endpoint keys its response off.
   */
  async getConsumption(contractId: string, resolution: ReadingResolution, fromDate: string): Promise<ConsumptionResult> {
    await this.checkToken();
    const devices = await this.getDevices(contractId);
    const first = devices[0];
    const meterSerial = first?.serialNumber ?? first?.deviceNumber;
    const meterCode = first?.deviceCode;
    if (!meterSerial || !meterCode) {
      throw new IECError(-1, 'No smart meter found on this contract');
    }

    // IEC requires a "last invoice date"; the last day of the previous
    // calendar month is a safe stand-in when the real one isn't known, same
    // as homebridge-iec-electricity falls back to. `Date(y, m, 0)` rolls back
    // to December of the prior year when `m` is 0 (January), so this needs no
    // special-casing at the year boundary.
    const now = new Date();
    const lastDayOfPrevMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    const lastInvoiceDate = isoDate(lastDayOfPrevMonth);

    const url = GET_REMOTE_READING_URL.replace('{contract_id}', contractId);
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({
        contractNumber: contractId,
        fromDate,
        lastInvoiceDate,
        resolution,
        smartMetersList: [{ meterKind: 'Consumption', meterCode, meterSerial }],
      }),
    });
    if (!response.ok) {
      throw new IECError(response.status, `Failed to get consumption (resolution=${resolution}): ${response.statusText}`);
    }
    const raw = (await response.json()) as Record<string, unknown>;
    this.log(`[IEC] RemoteReadingRange(resolution=${resolution}, from=${fromDate}): ${JSON.stringify(raw)}`);

    const meterList = (raw.meterList ?? []) as Array<Record<string, unknown>>;
    const meter = meterList[0];
    if (!meter) {
      return { periods: [], totalImport: null, totalForPeriod: null, periodEndReading: null, periodEndReadingDate: null };
    }

    const periods = ((meter.periodConsumptions ?? []) as Array<Record<string, unknown>>)
      .map((p) => ({ interval: String(p.interval ?? ''), consumption: Number(p.consumption) }))
      .filter((p) => p.interval && Number.isFinite(p.consumption));

    const future = meter.futureConsumptionInfo as Record<string, unknown> | undefined;
    const totalImport = numberOrNull(future?.totalImport ?? meter.totalImport);
    const totalForPeriod = numberOrNull(meter.totalConsumptionForPeriod);
    const periodEndReadingDateRaw = meter.totalImportDateForPeriod;
    const periodEndReadingDate = typeof periodEndReadingDateRaw === 'string' ? periodEndReadingDateRaw.slice(0, 10) : null;
    const periodEndReading = periodEndReadingDate ? numberOrNull(meter.totalImport) : null;

    return { periods, totalImport, totalForPeriod, periodEndReading, periodEndReadingDate };
  }

  /**
   * Fetches everything the exporter needs in one call: the account's first
   * contract, its newest published day (looking back a week, same lag
   * reasoning as the water client), and the current month's total.
   */
  async fetchSnapshot(): Promise<ElectricitySnapshot> {
    const customer = await this.getCustomer();
    const contracts = await this.getContracts(customer.bpNumber);
    const contract = contracts[0];
    if (!contract) {
      throw new IECError(-1, 'No contracts found for this account');
    }
    this.contractId = contract.contractId;

    const now = new Date();
    const dailyFrom = isoDate(addDays(now, -DAILY_LOOKBACK_DAYS));
    const monthlyFrom = isoDate(new Date(now.getFullYear(), now.getMonth(), 1));

    const daily = await this.getConsumption(contract.contractId, ReadingResolution.DAILY, dailyFrom);
    const monthly = await this.getConsumption(contract.contractId, ReadingResolution.MONTHLY, monthlyFrom);

    const newestDaily = [...daily.periods]
      .filter((p) => Number.isFinite(p.consumption))
      .sort((a, b) => b.interval.localeCompare(a.interval))[0];

    // MONTHLY already returns one period per calendar day within the month
    // (confirmed in the backfill CLI against a same-day DAILY call's
    // totalForPeriod) — reused here, at no extra API cost, to price the
    // month-to-date cost day by day rather than only by today's rate.
    const monthlyDailyConsumption = monthly.periods
      .map((p) => {
        const parsed = new Date(p.interval);
        return Number.isFinite(parsed.getTime()) ? { date: isoDate(parsed), consumption: p.consumption } : null;
      })
      .filter((p): p is { date: string; consumption: number } => p !== null);

    return {
      contractId: contract.contractId,
      contractNumber: contract.contractNumber,
      address: contract.address,
      meterReadingKwh: daily.totalImport ?? monthly.totalImport,
      daily: newestDaily?.consumption ?? null,
      dailyDate: newestDaily ? newestDaily.interval.slice(0, 10) : null,
      monthly: monthly.totalForPeriod,
      monthlyDailyConsumption,
      tokenExpiresAt: this.tokenExpiresAt(),
    };
  }
}

export interface ElectricitySnapshot {
  contractId: string;
  contractNumber?: string;
  address?: string;
  /** Cumulative meter reading, kWh. Null if IEC reported none. */
  meterReadingKwh: number | null;
  /** Consumption for the newest published day within the lookback window, kWh. */
  daily: number | null;
  /** Which day `daily` covers, YYYY-MM-DD. Null when `daily` is null. */
  dailyDate: string | null;
  /** Consumption so far this calendar month, kWh. */
  monthly: number | null;
  /** One entry per calendar day within the current month IEC has published consumption for, used to price month-to-date cost day by day. */
  monthlyDailyConsumption: Array<{ date: string; consumption: number }>;
  /** Epoch seconds the current id_token expires at, for the token-expiry alert. */
  tokenExpiresAt: number | null;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, 12);
}

function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}


function decodeExpiry(idToken: string): number | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8')) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}
