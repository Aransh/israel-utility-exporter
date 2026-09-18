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
 */
import { readFileSync } from 'node:fs';

export type Weekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
const WEEKDAYS: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface TariffWindow {
  days: Weekday[];
  /** "HH:MM", 24h. */
  start: string;
  /** "HH:MM", 24h. Must be later than `start` — express an overnight window as two entries. */
  end: string;
  /** 0-100. Percentage discount off `baseRatePerKwh` during this window. */
  discountPercent: number;
}

export interface TariffSchedule {
  currency: string;
  baseRatePerKwh: number;
  windows: TariffWindow[];
}

export class TariffScheduleError extends Error {}

export function loadTariffSchedule(path: string): TariffSchedule {
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
  return validateSchedule(parsed, path);
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
  const currency = typeof obj.currency === 'string' && obj.currency ? obj.currency : 'ILS';
  const rawWindows = Array.isArray(obj.windows) ? obj.windows : [];
  const windows = rawWindows.map((w, i) => validateWindow(w, i, path));
  return { currency, baseRatePerKwh, windows };
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
  if (end <= start) {
    throw new TariffScheduleError(
      `${label}: "end" (${String(obj.end)}) must be later than "start" (${String(obj.start)}) on the same day. ` +
        'Express an overnight window as two entries instead.',
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
  const applicable = schedule.windows.filter((w) => w.days.includes(weekday));
  if (applicable.length === 0) {
    return schedule.baseRatePerKwh;
  }

  const MINUTES_PER_DAY = 24 * 60;
  let discountedMinutes = 0;
  let totalDiscountedRate = 0; // sum of (rate * minutes) for discounted minutes, to allow differing discounts
  const covered = new Array<boolean>(MINUTES_PER_DAY).fill(false);

  for (const window of applicable) {
    const start = parseTimeOfDay(window.start, 'start');
    const end = parseTimeOfDay(window.end, 'end');
    const rate = schedule.baseRatePerKwh * (1 - window.discountPercent / 100);
    for (let minute = start; minute < end; minute += 1) {
      if (covered[minute]) {
        // Overlapping windows for the same weekday: first-listed wins, so the
        // schedule is deterministic rather than double-counting a minute.
        continue;
      }
      covered[minute] = true;
      discountedMinutes += 1;
      totalDiscountedRate += rate;
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
