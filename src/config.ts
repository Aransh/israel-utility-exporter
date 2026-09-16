import type { WeeklyWindow } from './water/rympro-client.js';

export class ConfigError extends Error {}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type TariffMode = 'flat' | 'schedule';

export interface WaterConfig {
  email: string;
  password: string;
  pollIntervalMs: number;
  weeklyWindow: WeeklyWindow;
  /** ILS per cubic meter. Null disables cost estimation. */
  pricePerCubicMeter: number | null;
}

export interface ElectricityConfig {
  israeliId: string;
  tokenFile: string;
  pollIntervalMs: number;
  tariffMode: TariffMode;
  /** ILS per kWh, used when tariffMode is "flat". Null disables cost estimation in flat mode. */
  pricePerKwh: number | null;
  /** Path to a time-of-use schedule JSON file, used when tariffMode is "schedule". */
  tariffScheduleFile: string | null;
}

export interface AppConfig {
  port: number;
  dataDir: string;
  logLevel: LogLevel;
  water: WaterConfig | null;
  electricity: ElectricityConfig | null;
  /** Path to an optional TLS/basic-auth config file. Null serves plain, unauthenticated HTTP. */
  webConfigFile: string | null;
}

const MIN_POLL_MINUTES = 15;
const DEFAULT_WATER_POLL_MINUTES = 90;
const DEFAULT_ELECTRICITY_POLL_MINUTES = 60;
const DEFAULT_PORT = 9877;
const DEFAULT_DATA_DIR = '/data';

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

  const water = isEnabled(env.WATER_ENABLED) ? loadWaterConfig(env) : null;
  const electricity = isEnabled(env.ELECTRICITY_ENABLED) ? loadElectricityConfig(env, dataDir) : null;

  if (!water && !electricity) {
    throw new ConfigError(
      'Neither WATER_ENABLED nor ELECTRICITY_ENABLED is set to "true" — nothing to export. ' +
        'Set at least one to true and its required variables.',
    );
  }

  return { port, dataDir, logLevel, water, electricity, webConfigFile };
}

function loadWaterConfig(env: NodeJS.ProcessEnv): WaterConfig {
  const email = env.WATER_EMAIL?.trim();
  const password = env.WATER_PASSWORD;
  if (!email || !password) {
    throw new ConfigError('WATER_ENABLED is true but WATER_EMAIL and/or WATER_PASSWORD is missing.');
  }

  const weeklyWindow: WeeklyWindow =
    env.WATER_WEEKLY_WINDOW === 'monday' || env.WATER_WEEKLY_WINDOW === 'rolling' ? env.WATER_WEEKLY_WINDOW : 'sunday';

  return {
    email,
    password,
    pollIntervalMs: pollMinutes(env.WATER_POLL_INTERVAL_MINUTES, DEFAULT_WATER_POLL_MINUTES, 'WATER_POLL_INTERVAL_MINUTES') * 60_000,
    weeklyWindow,
    pricePerCubicMeter: positiveFloatOrNull(env.WATER_PRICE_PER_CUBIC_METER),
  };
}

function loadElectricityConfig(env: NodeJS.ProcessEnv, dataDir: string): ElectricityConfig {
  const israeliId = env.ELECTRICITY_ID?.trim();
  if (!israeliId || !/^\d{9}$/.test(israeliId)) {
    throw new ConfigError('ELECTRICITY_ENABLED is true but ELECTRICITY_ID is missing or not a 9-digit Israeli ID.');
  }

  const tariffMode: TariffMode = env.ELECTRICITY_TARIFF_MODE === 'schedule' ? 'schedule' : 'flat';
  const pricePerKwh = positiveFloatOrNull(env.ELECTRICITY_PRICE_PER_KWH);
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

export function asLogLevel(value: string | undefined): LogLevel {
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}
