/**
 * Local-date/time-math helpers shared by both collectors and the backfill
 * CLI. Deliberately not pinned to a specific IANA zone (e.g. Asia/Jerusalem)
 * — everything here uses the Node process's own local timezone, matching how
 * both utility portals' "which calendar day is this" logic already gets
 * treated elsewhere in this codebase (see README's "Behavior worth knowing"
 * section). A backfilled historical point and a later live-scraped point for
 * the same day must resolve to the exact same timestamp here, or they'll
 * look like two different series values in the TSDB.
 */

export function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local noon of `ymd` — avoids DST edge cases when doing date arithmetic. */
export function parseYmdNoon(ymd: string): Date {
  const [year, month, day] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, day, 12);
}

/** Epoch seconds of local midnight of `ymd` — what the `*_covers_timestamp_seconds` gauges use. */
export function dateToEpochSeconds(ymd: string): number {
  const [year, month, day] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, day).getTime() / 1000;
}

export function shiftDays(ymd: string, days: number): string {
  return isoDate(new Date(parseYmdNoon(ymd).getTime() + days * 86_400_000));
}

/**
 * Every calendar month's first day, from the month containing `from` through
 * the month containing `to`, inclusive.
 */
export function enumerateMonthStarts(from: string, to: string): string[] {
  const starts: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const toYear = Number(to.slice(0, 4));
  const toMonth = Number(to.slice(5, 7));
  while (year < toYear || (year === toYear && month <= toMonth)) {
    starts.push(`${year}-${String(month).padStart(2, '0')}-01`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return starts;
}

const MONTH_ABBREVIATIONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Short month name (e.g. "Jul") for a YYYY-MM or YYYY-MM-DD string. A fixed
 * table instead of `toLocaleString` — deterministic regardless of the host's
 * ICU data, and this project never needs anything but English abbreviations.
 */
export function monthAbbreviation(ymd: string): string {
  const month = Number(ymd.slice(5, 7));
  return MONTH_ABBREVIATIONS[month - 1]!;
}
