# Historical data backfill

Full detail behind the [Historical data backfill](../README.md#historical-data-backfill)
section of the README.

```bash
node dist/backfill-cli.js --service all --days 90
node dist/backfill-cli.js --service electricity --from 2026-01-01 --to 2026-03-01
node dist/backfill-cli.js --service water --days 30 --dry-run   # preview only, no write
```

Running it interactively also asks whether to include **estimated** cumulative
meter readings (see below); pass `--estimated-readings` or
`--no-estimated-readings` to answer that up front instead (required in a
non-interactive/cron context — without one, it defaults to skipping them).

- **Match your scrape config's `job`/`instance` labels, or the graph will split
  in two.** Those labels are assigned by Prometheus itself when it scrapes a
  target — they're not part of `/metrics` — so a backfilled series has no
  `job`/`instance` label unless you add it yourself, making it a *different*
  series from the one your live scrapes produce for the same meter/contract.
  Set `REMOTE_WRITE_EXTRA_LABELS` to whatever your scrape config uses, e.g.
  for the `job_name`/target in `prometheus/prometheus.yml.example`:
  `REMOTE_WRITE_EXTRA_LABELS=job=israel-utility-exporter,instance=israel-utility-exporter:9877`.
- Backfills the **raw numbers the utility APIs report directly** (daily
  consumption for both utilities, weekly consumption for water — electricity
  has no weekly metric — and monthly consumption for both), plus, wherever a
  tariff is configured, the **cost/rate metrics derived from them**
  (`israel_utility_water_cost_estimate_ils`,
  `israel_utility_water_tariff_threshold_cubic_meters`,
  `israel_utility_water_effective_rate_ils_per_cubic_meter`,
  `israel_utility_water_tariff_normal_rate_ils_per_cubic_meter`,
  `israel_utility_electricity_cost_estimate_ils`,
  `israel_utility_electricity_cost_estimate_monthly_ils`,
  `israel_utility_electricity_effective_rate_ils_per_kwh`). Those are priced
  with **today's tariff config**, the same way the live collectors always
  price the current month/day — there's no record of what a historical day's
  rate actually was, so if your tariff (household size, per-m3 rate,
  time-of-use schedule, …) changed since the period you're backfilling, the
  resulting cost/rate samples for that period will reflect the current
  config, not the one that actually applied then. The water forecast metrics
  (`israel_utility_water_consumption_forecast_liters` and
  `israel_utility_water_cost_estimate_forecast_ils`) are never backfilled —
  a forecast is inherently forward-looking and has no historical equivalent.
- **The previous-month cost gauges are also backfilled**
  (`israel_utility_water_cost_estimate_previous_month_ils`,
  `israel_utility_electricity_cost_estimate_previous_month_ils`), derived
  from one calendar month before wherever the backfill range starts — an
  extra month water already fetches as part of its single combined range,
  and electricity fetches with one extra API call up front, then reuses
  from each loop iteration onward. A month whose predecessor has no data at
  all (e.g. the account didn't exist yet) is left unset rather than written
  as a misleading ₪0.
- **Optionally, the cumulative meter reading can also be backfilled** —
  `israel_utility_water_meter_reading_cubic_meters` and
  `israel_utility_electricity_meter_reading_kwh`. Both walk backward from a
  known reading, subtracting each day's already-fetched consumption, but
  how reliable that known reading is differs by service:
  - **Water** has no historical reading available anywhere in its API, so
    the anchor is today's *live* reading — a **best-effort estimate**, not
    a figure the portal ever reported for a past day.
  - **Electricity** is better than an estimate: IEC's own monthly response
    carries a genuine, dated reading for the requested month (distinct from
    the always-"as of now" figure the live gauge uses), so each month
    reconstructs from its own real historical anchor instead of one guess
    for the whole range.

  Either way, reconstruction stops rather than guessing as soon as it hits
  a day with no published consumption, or would otherwise go negative, so a
  real gap in the portal's history simply limits how far back it can go
  instead of producing wrong values past it. Neither can detect a meter
  swap, a meter reset, or a house move — any of those silently invalidates
  every reconstructed reading from before it happened, so skip this if one
  of those occurred within the range you're backfilling. Because of that,
  it's opt-in: pass `--estimated-readings`, or answer "y" at the
  interactive prompt.
- Monthly consumption is written as a **running month-to-date total, one
  sample per day** — the same thing the live gauge shows if scraped that
  day — not a single point on the 1st carrying the whole month's eventual
  total (which would misrepresent every earlier day, and wouldn't even be
  visible unless the dashboard's time range happens to reach back to that
  exact date, since one point every ~30 days is easy to scroll past).
- The range you can actually backfill is **limited to whatever the underlying
  portal API itself still retains** — there's no way to go back further than
  that, regardless of `--days`/`--from`.
- **Your remote_write receiver needs to be configured to accept historical
  timestamps, or it can silently drop them while still reporting success.**
  Prometheus's own remote-write receiver rejects out-of-order samples by
  default (`--storage.tsdb.out-of-order-time-window` defaults to `0`) — set
  it to cover your backfill range. Other receivers have their own retention/
  backfill-age limits. If a wide backfill looks incomplete, check the
  receiver's own logs/config rather than assuming the CLI missed something.
- Electricity requires a token already saved by `npm run login:electricity` —
  IEC's OTP login can't be automated here.
- Samples are timestamped at **local midnight** of the day they cover, the
  same semantics `*_covers_timestamp_seconds` already uses, so a backfilled
  point lines up with what a live scrape would have reported that day. Water's
  weekly total has no live `covers_timestamp` gauge to imitate, so its
  backfilled sample is timestamped at the **end of that week's bucket**
  instead; a week whose 7-day window extends past the requested `--to` is
  skipped rather than backfilled with a partial total that — unlike the live
  gauge — never gets corrected later.
- Writing uses the standard Prometheus **remote_write** protocol (protobuf +
  Snappy) — the same wire format Prometheus itself sends — so
  `REMOTE_WRITE_URL` can point at any compliant receiver (Prometheus with
  `--web.enable-remote-write-receiver`, Thanos, Cortex, Mimir, or any other
  remote_write-compatible TSDB). remote_write is naturally idempotent —
  writing the same series/timestamp/value again is a safe no-op — so it's
  safe to re-run the CLI over an overlapping range; a differing value at an
  already-written timestamp is simply rejected by the receiver.
- Without `REMOTE_WRITE_URL` set, only `--dry-run` works (it prints what would
  be sent, without requiring one).

See the [Configuration](../README.md#configuration) table for
`REMOTE_WRITE_*` variables, including TLS options (custom CA, client cert,
skip-verify) for a receiver on a private or self-signed certificate.
