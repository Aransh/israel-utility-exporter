/**
 * Cost estimation for consumption already fetched from the water/electricity
 * APIs. Three modes:
 *
 * - `flat`: one price times one quantity. The honest default for anyone not
 *   on a time-of-use or tiered plan, and the fallback for a plan that doesn't
 *   fit the models below.
 * - `schedule` (electricity): models Israeli time-of-use ("taoz") electricity
 *   plans, e.g. "70% off 17:00-23:00". IEC never reports consumption finer
 *   than a whole published day's total kWh (see README/plan notes — there is
 *   no hourly resolution to attribute usage within a day), so this computes a
 *   duration-weighted *blended* rate for the day being priced — the average
 *   rate across that day's 1440 minutes, weighted by how many of them fall in
 *   each tariff window — and multiplies the day's total kWh by that single
 *   number. This assumes consumption is spread evenly across the day; it is
 *   an estimate, not a bill reconstruction, and is exposed as its own metric
 *   so that assumption is visible rather than hidden inside a cost figure.
 * - `tiered` (water): models Israeli water tariffs, which have no
 *   time-of-use concept but are volume-tiered instead — a subsidized rate up
 *   to an allowance based on the number of people registered on the account,
 *   then a higher rate beyond it (see e.g.
 *   https://www.yuvallim.co.il/תעריפי-מים-וביוב/). Consumption up to
 *   `max(householdSize, 2) * allowancePerPersonCubicMeters` (every housing
 *   unit is guaranteed at least a 2-person allowance by law, regardless of
 *   registered headcount) is priced at `normalRatePerCubicMeter`, the rest
 *   at `excessRatePerCubicMeter`.
 *
 * Every configured rate is treated as pre-VAT and grossed up by
 * `VAT_PERCENT` (18% by default) before the functions below ever see it —
 * `config.ts` does this for `WaterTariffTiers` and the flat
 * `ElectricityPricingConfig.pricePerKwh`, and `loadTariffSchedule`'s
 * `vatPercent` argument does it for `TariffSchedule.baseRatePerKwh` — so
 * every rate and cost this module computes, and every gauge built from
 * them, is already VAT-inclusive. This matches how Israeli utility bills
 * are actually laid out: the per-unit rate is quoted before VAT, with VAT
 * added once, separately, on the invoice total.
 */
import { readFileSync } from 'node:fs';

export type Weekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
const WEEKDAYS: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface TariffWindow {
  days: Weekday[];
  /** "HH:MM", 24h. */
  start: string;
  /** "HH:MM", 24h. Earlier than `start` means the window wraps past midnight into the next day. Must not equal `start`. */
  end: string;
  /** 0-100. Percentage discount off `baseRatePerKwh` during this window. */
  discountPercent: number;
}

export interface TariffSchedule {
  baseRatePerKwh: number;
  windows: TariffWindow[];
}

export class TariffScheduleError extends Error {}

/**
 * Israeli utility bills quote the per-unit rate before VAT and add מע"מ
 * (VAT) once, separately, at the bottom of the invoice — confirmed against a
 * real IEC-supplier bill, where the per-kWh line items are explicitly
 * labeled "לא כולל מע"מ" (not including VAT) and the 18% VAT line only
 * appears once, on the invoice total. So every configured price is grossed
 * up by `vatPercent` at the point it's read (here, and in `config.ts` for
 * everything that isn't a schedule file), rather than expecting the user to
 * do the arithmetic themselves before pasting a rate off their bill.
 */
export function grossUpForVat(price: number | null, vatPercent: number): number | null {
  return price !== null ? price * (1 + vatPercent / 100) : null;
}

/**
 * `vatPercent` grosses up the file's `baseRatePerKwh` the same way
 * `config.ts` grosses up `ELECTRICITY_PRICE_PER_KWH` — the schedule file is
 * meant to hold the pre-VAT rate straight off a bill's per-window
 * breakdown, matching how Israeli utility bills quote it. Defaults to 0 (no
 * change) so callers that don't care about VAT — tests, mainly — don't need
 * to pass it.
 */
export function loadTariffSchedule(path: string, vatPercent = 0): TariffSchedule {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new TariffScheduleError(`Could not read tariff schedule at ${path}: ${describe(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TariffScheduleError(`Tariff schedule at ${path} is not valid JSON: ${describe(error)}`);
  }
  const schedule = validateSchedule(parsed, path);
  return { ...schedule, baseRatePerKwh: grossUpForVat(schedule.baseRatePerKwh, vatPercent)! };
}

function validateSchedule(value: unknown, path: string): TariffSchedule {
  if (typeof value !== 'object' || value === null) {
    throw new TariffScheduleError(`Tariff schedule at ${path} must be a JSON object.`);
  }
  const obj = value as Record<string, unknown>;
  const baseRatePerKwh = Number(obj.baseRatePerKwh);
  if (!Number.isFinite(baseRatePerKwh) || baseRatePerKwh <= 0) {
    throw new TariffScheduleError(`Tariff schedule at ${path}: "baseRatePerKwh" must be a positive number.`);
  }
  const rawWindows = Array.isArray(obj.windows) ? obj.windows : [];
  const windows = rawWindows.map((w, i) => validateWindow(w, i, path));
  return { baseRatePerKwh, windows };
}

function validateWindow(value: unknown, index: number, path: string): TariffWindow {
  const label = `Tariff schedule at ${path}, windows[${index}]`;
  if (typeof value !== 'object' || value === null) {
    throw new TariffScheduleError(`${label} must be an object.`);
  }
  const obj = value as Record<string, unknown>;
  const days = Array.isArray(obj.days) ? obj.days.filter(isWeekday) : [];
  if (days.length === 0) {
    throw new TariffScheduleError(`${label}: "days" must be a non-empty array of ${WEEKDAYS.join('/')}.`);
  }
  const start = parseTimeOfDay(obj.start, `${label}.start`);
  const end = parseTimeOfDay(obj.end, `${label}.end`);
  if (end === start) {
    throw new TariffScheduleError(
      `${label}: "start" and "end" must not be equal — a zero-length window isn't valid.`,
    );
  }
  const discountPercent = Number(obj.discountPercent);
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw new TariffScheduleError(`${label}: "discountPercent" must be between 0 and 100.`);
  }
  return { days: days as Weekday[], start: obj.start as string, end: obj.end as string, discountPercent };
}

function isWeekday(value: unknown): value is Weekday {
  return typeof value === 'string' && (WEEKDAYS as readonly string[]).includes(value);
}

/** Minutes since midnight, or throws if not "HH:MM" in range. */
function parseTimeOfDay(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(value)) {
    throw new TariffScheduleError(`${label} must be "HH:MM" (24h), got ${JSON.stringify(value)}.`);
  }
  const [h, m] = value.split(':').map(Number);
  return h! * 60 + m!;
}

/**
 * The duration-weighted average ILS/kWh rate for the given calendar day,
 * across every window that includes that weekday. Minutes not covered by any
 * window are priced at `baseRatePerKwh`.
 */
export function blendedRateForDay(schedule: TariffSchedule, date: Date): number {
  const weekday = WEEKDAYS[date.getDay()]!;
  const yesterday = WEEKDAYS[(date.getDay() + 6) % 7]!;

  const MINUTES_PER_DAY = 24 * 60;
  let discountedMinutes = 0;
  let totalDiscountedRate = 0; // sum of (rate * minutes) for discounted minutes, to allow differing discounts
  const covered = new Array<boolean>(MINUTES_PER_DAY).fill(false);

  const applyRange = (rate: number, from: number, to: number): void => {
    for (let minute = from; minute < to; minute += 1) {
      if (covered[minute]) {
        // Overlapping windows: first-listed wins, so the schedule is
        // deterministic rather than double-counting a minute.
        continue;
      }
      covered[minute] = true;
      discountedMinutes += 1;
      totalDiscountedRate += rate;
    }
  };

  for (const window of schedule.windows) {
    const start = parseTimeOfDay(window.start, 'start');
    const end = parseTimeOfDay(window.end, 'end');
    const rate = schedule.baseRatePerKwh * (1 - window.discountPercent / 100);

    if (end > start) {
      if (window.days.includes(weekday)) {
        applyRange(rate, start, end);
      }
    } else {
      // Overnight window: runs from `start` on a listed day through `end`
      // the following day. On the listed day it covers `start` through
      // midnight; on the day after, midnight through `end`.
      if (window.days.includes(weekday)) {
        applyRange(rate, start, MINUTES_PER_DAY);
      }
      if (window.days.includes(yesterday)) {
        applyRange(rate, 0, end);
      }
    }
  }

  const baseMinutes = MINUTES_PER_DAY - discountedMinutes;
  const totalRate = totalDiscountedRate + baseMinutes * schedule.baseRatePerKwh;
  return totalRate / MINUTES_PER_DAY;
}

export interface WaterTariffTiers {
  /** ILS per m3, for consumption up to the household's subsidized threshold. */
  normalRatePerCubicMeter: number;
  /** ILS per m3, for consumption beyond the household's subsidized threshold. */
  excessRatePerCubicMeter: number;
  /** Number of people registered on the water account. `waterTariffThreshold` floors this at 2 — see its comment. */
  householdSize: number;
  /** m3 per registered person before the higher rate applies. */
  allowancePerPersonCubicMeters: number;
}

/**
 * Israeli water tariffs guarantee every housing unit at least a 2-person
 * allowance regardless of how few people are actually registered there —
 * e.g. Yuval Lim's published tariff: "לא פחות מ-14 מ"ק לחודשיים ליחידת דיור
 * גם אם מתגוררים בה דרך קבע פחות משתי נפשות" (not less than 14 m3/2 months
 * per housing unit, even with fewer than two permanent residents). 14/2 = 7,
 * which is exactly 2 x the 3.5 m3/person/month allowance quoted alongside it
 * — the floor is derived from the per-person allowance, not an independent
 * number.
 */
const MINIMUM_HOUSEHOLD_SIZE_FOR_ALLOWANCE = 2;

/** The subsidized-rate threshold for this household, m3. */
export function waterTariffThreshold(tiers: WaterTariffTiers): number {
  return Math.max(tiers.householdSize, MINIMUM_HOUSEHOLD_SIZE_FOR_ALLOWANCE) * tiers.allowancePerPersonCubicMeters;
}

/**
 * ILS cost of `consumptionCubicMeters`, priced at `normalRatePerCubicMeter`
 * up to the household's subsidized threshold and `excessRatePerCubicMeter`
 * for the remainder.
 */
export function tieredWaterCost(tiers: WaterTariffTiers, consumptionCubicMeters: number): number {
  const threshold = waterTariffThreshold(tiers);
  if (consumptionCubicMeters <= threshold) {
    return consumptionCubicMeters * tiers.normalRatePerCubicMeter;
  }
  return threshold * tiers.normalRatePerCubicMeter + (consumptionCubicMeters - threshold) * tiers.excessRatePerCubicMeter;
}

/**
 * The average ILS/m3 rate that `tieredWaterCost` works out to for
 * `consumptionCubicMeters` — exposed as its own metric so the tiering isn't
 * hidden inside the cost figure, mirroring `blendedRateForDay` for
 * electricity's schedule mode.
 */
export function effectiveWaterRate(tiers: WaterTariffTiers, consumptionCubicMeters: number): number {
  if (consumptionCubicMeters <= 0) {
    return tiers.normalRatePerCubicMeter;
  }
  return tieredWaterCost(tiers, consumptionCubicMeters) / consumptionCubicMeters;
}

/**
 * Shaped like the slice of `WaterConfig` that pricing actually needs — kept
 * local (rather than imported from config.ts) to avoid a circular import,
 * since config.ts already imports `WaterTariffTiers` from this file.
 */
export interface WaterPricingConfig {
  tariffMode: 'flat' | 'tiered';
  tariffTiers: WaterTariffTiers | null;
  pricePerCubicMeter: number | null;
}

/**
 * ILS cost of `consumptionCubicMeters` under `config`'s tariff, or null if
 * unpriced (flat mode with no `pricePerCubicMeter` configured). Shared by the
 * live water collector and the backfill CLI so a future change to how a
 * reading gets priced can't update one and silently miss the other.
 */
export function waterCostEstimate(config: WaterPricingConfig, consumptionCubicMeters: number): number | null {
  if (config.tariffMode === 'tiered' && config.tariffTiers) {
    return tieredWaterCost(config.tariffTiers, consumptionCubicMeters);
  }
  return config.pricePerCubicMeter !== null ? consumptionCubicMeters * config.pricePerCubicMeter : null;
}

/** Shaped like the slice of `ElectricityConfig` that pricing actually needs — same circular-import reasoning as `WaterPricingConfig`. */
export interface ElectricityPricingConfig {
  pricePerKwh: number | null;
}

/**
 * ILS/kWh to price `date` at: `schedule`'s duration-weighted blended rate if
 * a schedule is configured, else `config`'s flat `pricePerKwh` (null if
 * unpriced). Shared by the live electricity collector and the backfill CLI.
 */
export function electricityEffectiveRate(
  config: ElectricityPricingConfig,
  schedule: TariffSchedule | null,
  date: Date,
): number | null {
  if (schedule) {
    return blendedRateForDay(schedule, date);
  }
  return config.pricePerKwh;
}

/**
 * ILS cost of a day-by-day electricity breakdown, each day priced at its own
 * `electricityEffectiveRate` and summed — the month-to-date figure
 * `israel_utility_electricity_cost_estimate_monthly_ils` exposes, mirroring
 * how `israel_utility_water_cost_estimate_ils` is already a month-to-date
 * total for water. Unlike water's tiered pricing, electricity's rate can
 * differ day to day (schedule mode), so this can't be derived from the
 * month's total kWh alone the way `waterCostEstimate` can — it needs the
 * per-day breakdown. Shared by the live electricity collector and the
 * backfill CLI. Returns null when unpriced (same condition under which
 * `electricityEffectiveRate` returns null for every day).
 */
export function electricityMonthlyCostEstimate(
  config: ElectricityPricingConfig,
  schedule: TariffSchedule | null,
  dailyConsumptionKwh: Array<{ date: Date; consumption: number }>,
): number | null {
  if (!schedule && config.pricePerKwh === null) {
    return null;
  }
  let total = 0;
  for (const { date, consumption } of dailyConsumptionKwh) {
    const rate = electricityEffectiveRate(config, schedule, date);
    if (rate !== null) {
      total += consumption * rate;
    }
  }
  return total;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
