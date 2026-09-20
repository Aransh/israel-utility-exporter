import { readFileSync } from 'node:fs';

import { grossUpForVat, type WaterTariffTiers } from './cost/tariff.js';
import { isValidIsraeliId } from './electricity/iec-client.js';
import type { WeeklyWindow } from './water/rympro-client.js';

export class ConfigError extends Error {}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type ElectricityTariffMode = 'flat' | 'schedule';
export type WaterTariffMode = 'flat' | 'tiered';

export interface WaterConfig {
  email: string;
  password: string;
  pollIntervalMs: number;
  weeklyWindow: WeeklyWindow;
  tariffMode: WaterTariffMode;
  /** ILS per cubic meter. Used when tariffMode is "flat"; also the tiered mode's below-allowance rate. Null disables cost estimation in flat mode. */
  pricePerCubicMeter: number | null;
  /** Set when tariffMode is "tiered". */
  tariffTiers: WaterTariffTiers | null;
}

export interface ElectricityConfig {
  israeliId: string;
  tokenFile: string;
  pollIntervalMs: number;
  tariffMode: ElectricityTariffMode;
  /** ILS per kWh, already grossed up by `vatPercent`, used when tariffMode is "flat". Null disables cost estimation in flat mode. */
  pricePerKwh: number | null;
  /** Path to a time-of-use schedule JSON file, used when tariffMode is "schedule". */
  tariffScheduleFile: string | null;
  /**
   * From `VAT_PERCENT`. Water's rates are grossed up by this once, here in
   * config loading (see `loadWaterConfig`); electricity's flat `pricePerKwh`
   * above is grossed up the same way, but the schedule file's
   * `baseRatePerKwh` lives outside this config object and is loaded
   * separately (by the live collector and the backfill CLI, each fetching
   * it fresh), so this is carried along for `loadTariffSchedule` to apply
   * it there instead.
   */
  vatPercent: number;
}

export interface RemoteWriteTlsConfig {
  /** Custom CA bundle (PEM contents), for a receiver with a private/self-signed certificate. */
  ca?: string;
  /** Client certificate (PEM contents), for mTLS. Set together with `key`. */
  cert?: string;
  /** Client private key (PEM contents), for mTLS. Set together with `cert`. */
  key?: string;
  insecureSkipVerify: boolean;
}

export interface RemoteWriteConfig {
  /** Standard Prometheus remote_write endpoint URL, e.g. `http://prometheus:9090/api/v1/write`. */
  url: string;
  username?: string;
  password?: string;
  bearerToken?: string;
  timeoutMs: number;
  tls: RemoteWriteTlsConfig;
}

export interface AppConfig {
  port: number;
  dataDir: string;
  logLevel: LogLevel;
  water: WaterConfig | null;
  electricity: ElectricityConfig | null;
  /** Path to an optional TLS/basic-auth config file. Null serves plain, unauthenticated HTTP. */
  webConfigFile: string | null;
  /** Set (via REMOTE_WRITE_URL) only when the backfill CLI is meant to push to a remote_write receiver. */
  remoteWrite: RemoteWriteConfig | null;
  /**
   * Extra labels (e.g. `job`, `instance`) applied to every backfilled series.
   * A live scrape target's `job`/`instance` labels are assigned by the
   * scraping Prometheus itself, not carried in `/metrics` — without these
   * set to match, backfilled and scraped points for the same series end up
   * as two distinct series with a different label set, splitting the graph.
   * Parsed independently of `REMOTE_WRITE_URL` so a `--dry-run` preview
   * (which doesn't require a URL) still shows the labels a real run would use.
   */
  remoteWriteExtraLabels: Record<string, string>;
}

const MIN_POLL_MINUTES = 15;
const DEFAULT_WATER_POLL_MINUTES = 90;
const DEFAULT_ELECTRICITY_POLL_MINUTES = 60;
const DEFAULT_PORT = 9877;
const DEFAULT_DATA_DIR = '/data';
/** Israel's standard VAT rate at the time of writing — see `VAT_PERCENT`. */
const DEFAULT_VAT_PERCENT = 18;

/**
 * Loads and validates configuration from the environment. Throws
 * `ConfigError` with a message meant to be logged and exited on, rather than
 * caught — a Docker container should fail fast and loudly on bad config
 * rather than serve an empty `/metrics` silently.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = intOr(env.PORT, DEFAULT_PORT, 'PORT');
  const dataDir = env.DATA_DIR?.trim() || DEFAULT_DATA_DIR;
  const logLevel = asLogLevel(env.LOG_LEVEL);
  const webConfigFile = env.WEB_CONFIG_FILE?.trim() || null;
  const vatPercent = nonNegativeFloatOr(env.VAT_PERCENT, DEFAULT_VAT_PERCENT, 'VAT_PERCENT');

  const water = isEnabled(env.WATER_ENABLED) ? loadWaterConfig(env, vatPercent) : null;
  const electricity = isEnabled(env.ELECTRICITY_ENABLED) ? loadElectricityConfig(env, dataDir, vatPercent) : null;

  if (!water && !electricity) {
    throw new ConfigError(
      'Neither WATER_ENABLED nor ELECTRICITY_ENABLED is set to "true" — nothing to export. ' +
        'Set at least one to true and its required variables.',
    );
  }

  return {
    port,
    dataDir,
    logLevel,
    water,
    electricity,
    webConfigFile,
    remoteWrite: loadRemoteWriteConfig(env),
    remoteWriteExtraLabels: parseExtraLabels(env.REMOTE_WRITE_EXTRA_LABELS),
  };
}

/**
 * `REMOTE_WRITE_URL`'s presence is what enables the backfill CLI's write
 * step — there is no separate `REMOTE_WRITE_ENABLED` flag. Mirrors the
 * options a Prometheus `remote_write:` config block itself supports
 * (basic_auth, bearer_token, tls_config), since that's what any compliant
 * remote_write receiver expects.
 */
function loadRemoteWriteConfig(env: NodeJS.ProcessEnv): RemoteWriteConfig | null {
  const url = env.REMOTE_WRITE_URL?.trim();
  if (!url) {
    return null;
  }

  const username = env.REMOTE_WRITE_USERNAME?.trim() || undefined;
  const password = env.REMOTE_WRITE_PASSWORD || undefined;
  if (Boolean(username) !== Boolean(password)) {
    throw new ConfigError('REMOTE_WRITE_USERNAME and REMOTE_WRITE_PASSWORD must both be set, or neither.');
  }
  const bearerToken = env.REMOTE_WRITE_BEARER_TOKEN?.trim() || undefined;
  if (bearerToken && (username || password)) {
    throw new ConfigError('Set either REMOTE_WRITE_BEARER_TOKEN or REMOTE_WRITE_USERNAME/REMOTE_WRITE_PASSWORD, not both.');
  }

  const caFile = env.REMOTE_WRITE_TLS_CA_FILE?.trim() || null;
  const certFile = env.REMOTE_WRITE_TLS_CERT_FILE?.trim() || null;
  const keyFile = env.REMOTE_WRITE_TLS_KEY_FILE?.trim() || null;
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new ConfigError('REMOTE_WRITE_TLS_CERT_FILE and REMOTE_WRITE_TLS_KEY_FILE must both be set, or neither.');
  }

  let ca: string | undefined;
  let cert: string | undefined;
  let key: string | undefined;
  try {
    if (caFile) ca = readFileSync(caFile, 'utf8');
    if (certFile) cert = readFileSync(certFile, 'utf8');
    if (keyFile) key = readFileSync(keyFile, 'utf8');
  } catch (error) {
    throw new ConfigError(`Could not read a REMOTE_WRITE_TLS_* file: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    url,
    username,
    password,
    bearerToken,
    timeoutMs: intOr(env.REMOTE_WRITE_TIMEOUT_MS, 30_000, 'REMOTE_WRITE_TIMEOUT_MS'),
    tls: { ca, cert, key, insecureSkipVerify: isEnabled(env.REMOTE_WRITE_TLS_INSECURE_SKIP_VERIFY) },
  };
}

/**
 * Parses a comma-separated `key=value,key=value` list into a label map.
 * Built on a null-prototype object so a label literally named `__proto__`
 * (however unlikely) becomes an ordinary own property instead of silently
 * reassigning the object's prototype.
 */
function parseExtraLabels(value: string | undefined): Record<string, string> {
  const labels: Record<string, string> = Object.create(null) as Record<string, string>;
  const raw = value?.trim();
  if (!raw) {
    return labels;
  }
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      throw new ConfigError(`REMOTE_WRITE_EXTRA_LABELS entry "${trimmed}" must be in key=value form.`);
    }
    const name = trimmed.slice(0, eq).trim();
    const labelValue = trimmed.slice(eq + 1).trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || name === '__name__') {
      throw new ConfigError(`REMOTE_WRITE_EXTRA_LABELS label name "${name}" is not a valid Prometheus label name.`);
    }
    labels[name] = labelValue;
  }
  return labels;
}

function loadWaterConfig(env: NodeJS.ProcessEnv, vatPercent: number): WaterConfig {
  const email = env.WATER_EMAIL?.trim();
  const password = env.WATER_PASSWORD;
  if (!email || !password) {
    throw new ConfigError('WATER_ENABLED is true but WATER_EMAIL and/or WATER_PASSWORD is missing.');
  }

  const weeklyWindow: WeeklyWindow =
    env.WATER_WEEKLY_WINDOW === 'monday' || env.WATER_WEEKLY_WINDOW === 'rolling' ? env.WATER_WEEKLY_WINDOW : 'sunday';

  const tariffMode: WaterTariffMode = env.WATER_TARIFF_MODE === 'tiered' ? 'tiered' : 'flat';
  const pricePerCubicMeter = grossUpForVat(positiveFloatOrNull(env.WATER_PRICE_PER_CUBIC_METER), vatPercent);
  const tariffTiers = tariffMode === 'tiered' ? loadWaterTariffTiers(env, pricePerCubicMeter, vatPercent) : null;

  return {
    email,
    password,
    pollIntervalMs: pollMinutes(env.WATER_POLL_INTERVAL_MINUTES, DEFAULT_WATER_POLL_MINUTES, 'WATER_POLL_INTERVAL_MINUTES') * 60_000,
    weeklyWindow,
    tariffMode,
    pricePerCubicMeter,
    tariffTiers,
  };
}

/**
 * `normalRatePerCubicMeter` is `WATER_PRICE_PER_CUBIC_METER` — the same
 * variable flat mode uses — since it means the same thing in both modes: the
 * price below the tiered mode's allowance threshold, or the only price in
 * flat mode.
 */
function loadWaterTariffTiers(env: NodeJS.ProcessEnv, normalRatePerCubicMeter: number | null, vatPercent: number): WaterTariffTiers {
  if (normalRatePerCubicMeter === null) {
    throw new ConfigError(
      'WATER_TARIFF_MODE is "tiered" but WATER_PRICE_PER_CUBIC_METER (the below-allowance rate) is missing or not a positive number.',
    );
  }
  const excessRatePerCubicMeter = grossUpForVat(positiveFloatOrNull(env.WATER_TARIFF_EXCESS_PRICE_PER_CUBIC_METER), vatPercent);
  if (excessRatePerCubicMeter === null) {
    throw new ConfigError('WATER_TARIFF_MODE is "tiered" but WATER_TARIFF_EXCESS_PRICE_PER_CUBIC_METER is missing or not a positive number.');
  }
  const householdSize = positiveIntOrNull(env.WATER_TARIFF_HOUSEHOLD_SIZE);
  if (householdSize === null) {
    throw new ConfigError('WATER_TARIFF_MODE is "tiered" but WATER_TARIFF_HOUSEHOLD_SIZE is missing or not a positive integer.');
  }
  const allowancePerPersonCubicMeters = positiveFloatOrNull(env.WATER_TARIFF_ALLOWANCE_PER_PERSON_CUBIC_METERS);
  if (allowancePerPersonCubicMeters === null) {
    throw new ConfigError(
      'WATER_TARIFF_MODE is "tiered" but WATER_TARIFF_ALLOWANCE_PER_PERSON_CUBIC_METERS is missing or not a positive number.',
    );
  }
  return { normalRatePerCubicMeter, excessRatePerCubicMeter, householdSize, allowancePerPersonCubicMeters };
}

function loadElectricityConfig(env: NodeJS.ProcessEnv, dataDir: string, vatPercent: number): ElectricityConfig {
  const israeliId = env.ELECTRICITY_ID?.trim();
  // The one validator here that isn't a small local helper: the Teudat
  // Zehut checksum is IEC/Israeli-ID domain logic, not generic config
  // parsing, so it stays defined alongside IecClient's own use of it
  // instead of being duplicated here.
  if (!israeliId || !isValidIsraeliId(israeliId)) {
    throw new ConfigError(
      'ELECTRICITY_ENABLED is true but ELECTRICITY_ID is missing or not a valid 9-digit Israeli ID (checksum failed).',
    );
  }

  const tariffMode: ElectricityTariffMode = env.ELECTRICITY_TARIFF_MODE === 'schedule' ? 'schedule' : 'flat';
  const pricePerKwh = grossUpForVat(positiveFloatOrNull(env.ELECTRICITY_PRICE_PER_KWH), vatPercent);
  const tariffScheduleFile = env.ELECTRICITY_TARIFF_SCHEDULE_FILE?.trim() || null;

  if (tariffMode === 'schedule' && !tariffScheduleFile) {
    throw new ConfigError('ELECTRICITY_TARIFF_MODE is "schedule" but ELECTRICITY_TARIFF_SCHEDULE_FILE is not set.');
  }

  return {
    israeliId,
    tokenFile: env.ELECTRICITY_TOKEN_FILE?.trim() || `${dataDir}/iec-token.json`,
    pollIntervalMs:
      pollMinutes(env.ELECTRICITY_POLL_INTERVAL_MINUTES, DEFAULT_ELECTRICITY_POLL_MINUTES, 'ELECTRICITY_POLL_INTERVAL_MINUTES') * 60_000,
    tariffMode,
    pricePerKwh,
    tariffScheduleFile,
    vatPercent,
  };
}

function isEnabled(value: string | undefined): boolean {
  return (value ?? '').trim().toLowerCase() === 'true';
}

function pollMinutes(value: string | undefined, fallback: number, field: string): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ConfigError(`${field} must be a number, got "${value}".`);
  }
  return Math.max(MIN_POLL_MINUTES, n);
}

function intOr(value: string | undefined, fallback: number, field: string): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`${field} must be a positive integer, got "${value}".`);
  }
  return n;
}

function positiveFloatOrNull(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function nonNegativeFloatOr(value: string | undefined, fallback: number, field: string): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ConfigError(`${field} must be a non-negative number, got "${value}".`);
  }
  return n;
}

function positiveIntOrNull(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') {
    return null;
  }
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function asLogLevel(value: string | undefined): LogLevel {
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}
