#!/usr/bin/env node
/**
 * Backfills historical daily/weekly/monthly consumption — plus, where a
 * tariff is configured, the cost/rate metrics derived from it — into a
 * Prometheus remote_write receiver, for data older than either collector's
 * live lookback window (or predating the exporter's first deployment).
 *
 * Cost/rate figures are computed with *today's* tariff config (there is no
 * record of what a historical day's rate actually was), the same way the
 * live collectors always price the current month/day. If your tariff
 * (household size, per-m3 rate, time-of-use schedule, …) changed since the
 * period being backfilled, the resulting cost/rate samples for that period
 * will reflect the current config, not the one that actually applied then.
 * There's no historical equivalent for the water forecast metrics
 * (`*_forecast_liters`/`*_cost_estimate_forecast_ils`) — a forecast is
 * inherently forward-looking — so those are never backfilled.
 *
 *   node dist/backfill-cli.js --service water|electricity|all \
 *     (--days 90 | --from 2026-01-01 --to 2026-03-01) [--dry-run]
 *
 * remote_write is naturally idempotent — the same series+timestamp+value is
 * a safe no-op to write again — so this is safe to re-run over an
 * overlapping range.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { type AppConfig, type ElectricityConfig, loadConfig, type WaterConfig } from './config.js';
import {
  effectiveWaterRate,
  electricityEffectiveRate,
  loadTariffSchedule,
  type TariffSchedule,
  waterCostEstimate,
  waterTariffThreshold,
} from './cost/tariff.js';
import { IecClient, ReadingResolution } from './electricity/iec-client.js';
import { createLogger, type Logger } from './logger.js';
import { remoteWrite, type RemoteWriteSettings } from './remote-write/client.js';
import { buildTimeSeries, type SamplePoint } from './remote-write/series-builder.js';
import { dateToEpochSeconds, enumerateMonthStarts, isoDate, parseYmdNoon, shiftDays } from './time/day.js';
import { enumerateWeekStarts, RymProClient, sumWeek } from './water/rympro-client.js';

const CHUNK_SIZE = 500;
const WEEK_LENGTH_DAYS = 7;

type Service = 'water' | 'electricity' | 'all';

export interface CliArgs {
  service: Service;
  from?: string;
  to?: string;
  days?: number;
  dryRun: boolean;
}

function printUsage(): void {
  console.error(
    'Usage: node dist/backfill-cli.js --service water|electricity|all (--days N | --from YYYY-MM-DD --to YYYY-MM-DD) [--dry-run]',
  );
  console.error(
    'Pushes historical daily/weekly/monthly consumption to REMOTE_WRITE_URL via Prometheus remote_write. ' +
      'See the README\'s "Historical data backfill" section.',
  );
}

export function parseArgs(argv: string[]): CliArgs {
  let service: Service | undefined;
  let from: string | undefined;
  let to: string | undefined;
  let days: number | undefined;
  let dryRun = false;

  const requireValue = (flag: string, index: number): string => {
    const value = argv[index];
    if (value === undefined) {
      throw new Error(`${flag} requires a value.`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--service') {
      const value = requireValue('--service', i + 1);
      if (value !== 'water' && value !== 'electricity' && value !== 'all') {
        throw new Error(`--service must be "water", "electricity", or "all", got "${value}".`);
      }
      service = value;
      i += 1;
    } else if (arg === '--from') {
      from = requireValue('--from', i + 1);
      i += 1;
    } else if (arg === '--to') {
      to = requireValue('--to', i + 1);
      i += 1;
    } else if (arg === '--days') {
      days = Number(requireValue('--days', i + 1));
      i += 1;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unrecognized argument: "${arg}".`);
    }
  }

  if (days !== undefined && (from !== undefined || to !== undefined)) {
    throw new Error('--days cannot be combined with --from/--to.');
  }
  if (days === undefined && (from === undefined || to === undefined)) {
    throw new Error('Specify either --days N or both --from and --to — there is no default range.');
  }
  if (days !== undefined && (!Number.isInteger(days) || days <= 0)) {
    throw new Error('--days must be a positive integer.');
  }

  return { service: service ?? 'all', from, to, days, dryRun };
}

/** True only for a real calendar date in `YYYY-MM-DD` form — rejects overflow like `2026-02-31`. */
function isValidYmd(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && isoDate(parseYmdNoon(value)) === value;
}

export function resolveRange(args: CliArgs): { from: string; to: string } {
  if (args.days !== undefined) {
    const to = isoDate(new Date());
    // `--days N` means N calendar days ending today, inclusive — N-1 back from today.
    return { from: shiftDays(to, -(args.days - 1)), to };
  }
  const from = args.from!;
  const to = args.to!;
  if (!isValidYmd(from) || !isValidYmd(to)) {
    throw new Error('--from/--to must be real calendar dates in YYYY-MM-DD format.');
  }
  if (from > to) {
    throw new Error('--from must not be after --to.');
  }
  return { from, to };
}

export async function collectWater(config: WaterConfig, from: string, to: string, log: Logger): Promise<SamplePoint[]> {
  const client = new RymProClient(config.email, config.password, randomUUID(), {
    weeklyWindow: config.weeklyWindow,
    onRetry: (message) => log.debug(`Water backfill: ${message}`),
  });
  await client.login();
  const meters = await client.listMeters();

  // Fetched from the start of the calendar month containing `from`, not
  // `from` itself, so a month's running total (below) is correct even when
  // `from` starts mid-month — days before `from` still contribute to that
  // month's cumulative, they just aren't written as their own daily points.
  const fetchFrom = enumerateMonthStarts(from, to)[0] ?? from;

  // Depends only on `config`, never on the date or a day's cumulative
  // consumption, so it's computed once up front rather than on every
  // iteration of the (potentially long) day loop below.
  const tariffTiers = config.tariffMode === 'tiered' ? config.tariffTiers : null;
  const tariffThreshold = tariffTiers ? waterTariffThreshold(tariffTiers) : null;

  const points: SamplePoint[] = [];
  for (const meter of meters) {
    const labels = { meter_id: String(meter.meterCount), meter_serial: typeof meter.meterId === 'string' ? meter.meterId : '' };
    const daily = await client.dailyConsumptionRange(meter.meterCount, fetchFrom, to);

    for (const day of daily) {
      if (day.date < from) {
        continue; // fetched only to support the monthly running total below, not itself requested
      }
      const timestampMs = dateToEpochSeconds(day.date) * 1000;
      points.push({ metric: 'israel_utility_water_consumption_daily_liters', labels, timestampMs, value: day.value * 1000 });
      points.push({
        metric: 'israel_utility_water_consumption_daily_covers_timestamp_seconds',
        labels,
        timestampMs,
        value: timestampMs / 1000,
      });
    }

    // No live `covers_timestamp` gauge exists for the weekly total, so the
    // end of the week bucket is used as its remote_write sample timestamp —
    // "this total as of the end of this week", the same instant a live
    // scrape late in that week would have reported. A week whose window
    // extends past `to` is skipped rather than backfilled with a partial
    // total that — unlike the live gauge — never gets corrected later.
    for (const weekStartYmd of enumerateWeekStarts(from, to, config.weeklyWindow)) {
      const weekEnd = shiftDays(weekStartYmd, WEEK_LENGTH_DAYS - 1);
      // A fixed sunday/monday window can start before `from` (it snaps to the
      // calendar week containing `from`, not `from` itself) — `daily` was
      // only fetched from `from` onward, so that first bucket would otherwise
      // look like a complete week while actually missing its leading days.
      if (weekStartYmd < from || weekEnd > to) {
        continue;
      }
      const { value, counted } = sumWeek(daily, weekStartYmd);
      if (value === null) {
        continue;
      }
      const timestampMs = dateToEpochSeconds(weekEnd) * 1000;
      points.push({ metric: 'israel_utility_water_consumption_weekly_liters', labels, timestampMs, value: value * 1000 });
      points.push({ metric: 'israel_utility_water_consumption_weekly_days_counted', labels, timestampMs, value: counted });
    }

    // A single point stamped at the 1st carrying the *whole* month's
    // eventual total would misrepresent every earlier day (and isn't even
    // visible unless the viewed time range happens to reach back to that
    // date). Instead this mirrors what the live "month to date" gauge would
    // have shown if scraped each day: a running total, one sample per day,
    // derived from the same daily figures already fetched above.
    for (const monthStart of enumerateMonthStarts(from, to)) {
      const monthKey = monthStart.slice(0, 7);
      const monthDays = daily.filter((day) => day.date.slice(0, 7) === monthKey).sort((a, b) => a.date.localeCompare(b.date));
      let cumulative = 0;
      for (const day of monthDays) {
        cumulative += day.value;
        if (day.date < from || day.date > to) {
          continue;
        }
        const timestampMs = dateToEpochSeconds(day.date) * 1000;
        points.push({ metric: 'israel_utility_water_consumption_monthly_liters', labels, timestampMs, value: cumulative * 1000 });

        if (tariffTiers && tariffThreshold !== null) {
          points.push({
            metric: 'israel_utility_water_tariff_threshold_cubic_meters',
            labels,
            timestampMs,
            value: tariffThreshold,
          });
          points.push({
            metric: 'israel_utility_water_effective_rate_ils_per_cubic_meter',
            labels,
            timestampMs,
            value: effectiveWaterRate(tariffTiers, cumulative),
          });
        }
        const cost = waterCostEstimate(config, cumulative);
        if (cost !== null) {
          points.push({ metric: 'israel_utility_water_cost_estimate_ils', labels, timestampMs, value: cost });
        }
      }
    }
  }
  return points;
}

export async function collectElectricity(config: ElectricityConfig, from: string, to: string, log: Logger): Promise<SamplePoint[]> {
  // Loaded/validated before any network call, exactly like the live
  // collector's constructor does it — a bad schedule file must fail fast,
  // not after already spending IEC API quota on a run that was going to be
  // discarded anyway.
  const tariffSchedule: TariffSchedule | null =
    config.tariffMode === 'schedule' && config.tariffScheduleFile ? loadTariffSchedule(config.tariffScheduleFile) : null;

  const client = new IecClient(config.israeliId, { log: (msg) => log.debug(`Electricity backfill: ${msg}`) });
  try {
    await client.loadTokenFromFile(config.tokenFile);
  } catch (error) {
    throw new Error(
      `Could not load IEC token from ${config.tokenFile}: ${error instanceof Error ? error.message : String(error)}. ` +
        'Run `npm run login:electricity` first.',
      { cause: error },
    );
  }

  const customer = await client.getCustomer();
  const contracts = await client.getContracts(customer.bpNumber);
  const contract = contracts[0];
  if (!contract) {
    throw new Error('No contracts found for this IEC account.');
  }
  const labels = { contract_id: contract.contractId };

  // DAILY resolution does not return a range at all — `fromDate` selects a
  // single calendar day and the response is that day's 15-minute-interval
  // sub-readings (confirmed against the live API: startDate == endDate ==
  // fromDate, numberOfPeriodAggregated: 1). MONTHLY resolution, however,
  // already returns one period per calendar day within the month alongside
  // the month's own total — verified to match a same-day DAILY call's
  // totalForPeriod exactly — so a single MONTHLY call per month (which we
  // need anyway for the monthly figure) gives us real daily data for free,
  // with no separate DAILY calls needed.
  const dailyByDate = new Map<string, number>();
  const points: SamplePoint[] = [];
  for (const monthStart of enumerateMonthStarts(from, to)) {
    const monthly = await client.getConsumption(contract.contractId, ReadingResolution.MONTHLY, monthStart);
    const monthKey = monthStart.slice(0, 7);
    const monthDays: Array<{ date: string; consumption: number }> = [];

    for (const period of monthly.periods) {
      // `interval` is a true UTC timestamp (e.g. "...T21:00:00+00:00"); in a
      // timezone ahead of UTC (Israel included) naively slicing the string
      // misattributes any entry landing in the last hours of the UTC day to
      // the wrong local calendar date. Parsing it and reading local getters
      // (via `isoDate`) gets the actual local day right.
      const parsedInterval = new Date(period.interval);
      if (!Number.isFinite(parsedInterval.getTime())) {
        continue; // an unparseable interval must never produce a NaN sample timestamp
      }
      const date = isoDate(parsedInterval);
      if (date.slice(0, 7) === monthKey) {
        monthDays.push({ date, consumption: period.consumption });
      }
      if (date >= from && date <= to) {
        dailyByDate.set(date, period.consumption);
      }
    }

    // A single point stamped at the 1st carrying the *whole* month's
    // eventual total would misrepresent every earlier day (and isn't even
    // visible unless the viewed time range happens to reach back to that
    // date). Instead this mirrors what the live "month to date" gauge would
    // have shown if scraped each day: a running total, one sample per day.
    // Needs every day of the month up to `to`, even ones before `from` if
    // `from` starts mid-month — MONTHLY already returns the whole month
    // (or month-to-date) regardless of the requested `fromDate`'s day —
    // but only days within [from, to] are actually written.
    monthDays.sort((a, b) => a.date.localeCompare(b.date));
    let cumulative = 0;
    for (const { date, consumption } of monthDays) {
      cumulative += consumption;
      if (date < from || date > to) {
        continue;
      }
      const timestampMs = dateToEpochSeconds(date) * 1000;
      points.push({ metric: 'israel_utility_electricity_consumption_monthly_kwh', labels, timestampMs, value: cumulative });
    }
  }

  for (const [date, consumption] of dailyByDate) {
    const timestampMs = dateToEpochSeconds(date) * 1000;
    points.push({ metric: 'israel_utility_electricity_consumption_daily_kwh', labels, timestampMs, value: consumption });
    points.push({
      metric: 'israel_utility_electricity_consumption_daily_covers_timestamp_seconds',
      labels,
      timestampMs,
      value: timestampMs / 1000,
    });

    const rate = electricityEffectiveRate(config, tariffSchedule, parseYmdNoon(date));
    if (rate === null) {
      continue;
    }
    if (tariffSchedule) {
      points.push({ metric: 'israel_utility_electricity_effective_rate_ils_per_kwh', labels, timestampMs, value: rate });
    }
    points.push({ metric: 'israel_utility_electricity_cost_estimate_ils', labels, timestampMs, value: consumption * rate });
  }

  return points;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    process.exitCode = 1;
    return;
  }

  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(`Configuration error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  if (args.service === 'water' && !config.water) {
    console.error('--service water was requested but WATER_ENABLED is not "true".');
    process.exitCode = 1;
    return;
  }
  if (args.service === 'electricity' && !config.electricity) {
    console.error('--service electricity was requested but ELECTRICITY_ENABLED is not "true".');
    process.exitCode = 1;
    return;
  }
  const runWater = (args.service === 'water' || args.service === 'all') && config.water !== null;
  const runElectricity = (args.service === 'electricity' || args.service === 'all') && config.electricity !== null;
  if (!runWater && !runElectricity) {
    console.error('No enabled service to backfill — check WATER_ENABLED/ELECTRICITY_ENABLED.');
    process.exitCode = 1;
    return;
  }

  if (!args.dryRun && !config.remoteWrite) {
    console.error('REMOTE_WRITE_URL is not set. Set it, or pass --dry-run to preview without sending.');
    process.exitCode = 1;
    return;
  }

  let range: { from: string; to: string };
  try {
    range = resolveRange(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  const { from, to } = range;

  const log = createLogger(config.logLevel);
  const points: SamplePoint[] = [];
  try {
    if (runWater) {
      points.push(...(await collectWater(config.water!, from, to, log)));
    }
    if (runElectricity) {
      points.push(...(await collectElectricity(config.electricity!, from, to, log)));
    }
  } catch (error) {
    console.error(`Backfill failed while fetching data: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  if (points.length === 0) {
    console.log(`Nothing to backfill: no data was published for ${from}..${to}.`);
    return;
  }

  // A live scrape target's `job`/`instance` labels come from Prometheus's own
  // scrape config, not from `/metrics` — without applying the same values
  // here, a backfilled series and its later live-scraped counterpart end up
  // as two distinct series (different label sets), splitting the graph.
  const extraLabels = config.remoteWriteExtraLabels;
  const series = buildTimeSeries(points.map((point) => ({ ...point, labels: { ...extraLabels, ...point.labels } })));
  const totalSamples = series.reduce((sum, ts) => sum + ts.samples.length, 0);

  if (args.dryRun) {
    console.log(`Dry run: would write ${series.length} series / ${totalSamples} samples for range ${from}..${to}.`);
    for (const ts of series) {
      const name = ts.labels.find((label) => label.name === '__name__')?.value ?? '?';
      const labelStr = ts.labels
        .filter((label) => label.name !== '__name__')
        .map((label) => `${label.name}="${label.value}"`)
        .join(',');
      const first = ts.samples[0]!;
      const last = ts.samples[ts.samples.length - 1]!;
      console.log(
        `  ${name}{${labelStr}}: ${ts.samples.length} samples, ${new Date(first.timestampMs).toISOString()} .. ${new Date(last.timestampMs).toISOString()}`,
      );
    }
    return;
  }

  const remoteWriteConfig = config.remoteWrite!;
  const settings: RemoteWriteSettings = {
    url: remoteWriteConfig.url,
    username: remoteWriteConfig.username,
    password: remoteWriteConfig.password,
    bearerToken: remoteWriteConfig.bearerToken,
    timeoutMs: remoteWriteConfig.timeoutMs,
    tls: remoteWriteConfig.tls,
  };

  const chunks = chunk(series, CHUNK_SIZE);
  let sent = 0;
  for (const [index, batch] of chunks.entries()) {
    try {
      await remoteWrite(settings, batch);
      sent += batch.length;
      log.info(`Wrote batch ${index + 1}/${chunks.length} (${batch.length} series) to ${remoteWriteConfig.url}.`);
    } catch (error) {
      console.error(`remote_write failed on batch ${index + 1}/${chunks.length}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`Backfill complete: wrote ${sent} series / ${totalSamples} samples for range ${from}..${to}.`);
}

// Guards against running `main()` as a side effect of importing this module
// (e.g. from a test importing `parseArgs`/`resolveRange`/`chunk`) — only run
// it when this file is the actual entry point.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
