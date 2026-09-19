# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released version has a matching `vX.Y.Z` git tag; the release workflow uses
the section below the matching heading as the GitHub release notes, so keep the
headings in the `## [x.y.z] - YYYY-MM-DD` form.

## [Unreleased]

## [0.6.3] - 2026-09-19

### Fixed

- `backfill-cli.js`'s meter-reading reconstruction (`--estimated-readings`)
  never wrote a point at today's date on an account whose portal publishes
  its per-day consumption breakdown with a multi-day lag — confirmed against
  a real account where RymPro's breakdown lagged 3 days behind "now".
  `reconstructMeterReadings`/`reconstructElectricityMeterReading` anchor the
  backward walk on the newest day with *published daily consumption*, by
  design (see their own doc comments) — reasonable for every day before
  that, but it meant the live reading already fetched for that anchor
  (`meter.read` for water, `totalImport` for electricity, both always
  "now", never historical) was being *dated* several days stale instead of
  written at today's date where it belongs. Since the "Water/Electricity
  Meter Reading" panels are pinned to `timeFrom: 2d`, a lag past 2 days
  meant backfill could never put a single sample inside that window, no
  matter how densely the rest of history was written — the sparkline
  stayed empty until the live exporter's own scrapes eventually caught up,
  which could take days depending on the account. Fixed by writing that
  already-fetched live value at today's date too (in addition to, not
  instead of, the backward-reconstructed history), densified the same way
  as everything else in `sparklineTimestamps`'s tail window.

## [0.6.1] - 2026-09-19

### Added

- `israel_utility_electricity_cost_estimate_monthly_ils`: month-to-date
  electricity cost, each published day priced at its own rate and summed —
  unlike water's tiered cost, electricity's rate can vary day to day
  (schedule mode), so this can't be derived from the month's total kWh
  alone. Also backfilled by `backfill-cli.js`. The "Electricity Cost
  Estimate (Newest Day)" dashboard panel now shows this month-to-date figure
  instead, matching the "Water Cost" panel's treatment.
- `israel_utility_water_cost_estimate_previous_month_ils` and
  `israel_utility_electricity_cost_estimate_previous_month_ils`: last
  calendar month's final cost, for comparison against the month-to-date
  figure — priced with today's tariff, not necessarily the one that applied
  last month, same caveat as everything else this exporter prices
  historically. Live collectors only (one extra API call per poll to fetch
  last month's total); not backfilled. Shown as a muted (gray, no sparkline)
  third value in the "Water Cost" and "Electricity Cost (Month to Date)"
  dashboard panels — Grafana stat panels don't support a smaller font per
  value, only per-value color, so that's as visually secondary as it gets.

### Fixed

- `backfill-cli.js`'s interactive confirmation prompt read as broken English
  ("Also backfill estimated the cumulative water meter reading...") — it was
  missing an article before "estimated".
- `backfill-cli.js`'s electricity meter-reading reconstruction logged a WARN
  at every single month boundary it crossed ("no published consumption
  before that date"), even though stopping there is the intended behavior —
  each month reconstructs independently from its own dated reading (see
  `reconstructElectricityMeterReading`), so it always runs out of same-month
  data at the previous month's last day. That expected case now logs at
  debug level with wording that says so; a stop anywhere else in the month
  (a genuine gap) still logs a WARN.
- The dashboard's cumulative meter-reading panels (water and electricity)
  and their stat-panel sparklines rendered as disconnected dots instead of a
  connected line/area, because the gap between two real samples is often
  wider than Grafana's default null-gap heuristic tolerates for that field.
  Both now set `spanNulls: true`.
- The "Water/Electricity Meter Reading", "Water/Electricity Cost", and
  "Effective Rate" stat panels never set an explicit `thresholds` color, so
  they silently inherited Grafana's schema default (green below 80, red at
  or above) — a plain meter reading or cost figure crossing 80 (in whatever
  unit Prometheus stores it in, e.g. kWh for a MWh-displayed reading) turned
  it red for no real reason. Confirmed against the actual numbers this
  exporter produces once seeded with realistic demo data, rather than only
  the small values that happened to stay under 80 in earlier testing. Fixed
  by giving each an explicit, always-green threshold.
- The "Water/Electricity Meter Reading", "Water/Electricity Cost", "Water
  Rate vs Normal", and "Effective Rate" stat panels' sparklines (the
  background trend behind the big number) silently rendered nothing once
  their query's own time range grew past roughly 2 days — confirmed against
  Grafana's own official server-side renderer and three different Grafana
  versions (11.0.0 through 13.2.2), so this is a genuine limitation of
  Grafana's stat-panel sparkline, not a misconfiguration or a rendering-tool
  quirk. It's invisible on a freshly-provisioned demo dashboard (whose
  default range is "Last 30 days") but the same silent cutoff applies to any
  Prometheus data, real or synthetic. Fixed by pinning each of those panels
  to `timeFrom: 2d`, independent of whatever range the rest of the dashboard
  is showing — the same real per-minute Prometheus scrape data that made the
  sparkline invisible at 30 days renders it fine at 2.
- The "Water Cost" and "Electricity Cost (Month to Date)" panels' sparklines
  for the "Month to date"/"Forecast" values rendered as a barely-visible
  sliver even after the fix above, because a stat panel with multiple fields
  auto-scales its sparklines' Y-axis using *all* fields' values by default —
  including "Last month" (a much larger number that doesn't even draw a
  sparkline itself, `graphMode: none`), which squashed the actually-relevant
  trend into a thin band. Fixed by setting `fieldMinMax: true` so each
  field's sparkline scales to its own range instead of sharing one across
  the whole panel.

## [0.6.2] - 2026-09-19

### Changed

- `backfill-cli.js` now logs an info-level line before each meter's daily
  fetch (water) and each month's fetch (electricity), plus one for
  login/account-details — a multi-month backfill makes several sequential
  portal/IEC API calls that can each take a couple of seconds, but at the
  default `LOG_LEVEL=info` a slow-but-working run and a genuinely hung one
  previously looked identical from the terminal.
- Every dashboard panel showing a cost or rate figure now says so in its
  title, not just its description: "Water Cost" → "Water Cost Estimate",
  "Water Rate vs Normal (Tiered Mode)" → "Estimated Water Rate vs Normal
  (Tiered Mode)", "Electricity Cost (Month to Date)" → "Electricity Cost
  Estimate (Month to Date)", "Effective Rate (Today, Schedule Mode)" →
  "Estimated Effective Rate (Today, Schedule Mode)". These are all priced
  with today's tariff config against Prometheus-reported consumption, not a
  figure the utility itself has billed — that caveat shouldn't require
  opening the panel's description to see.

### Fixed

- The "Water/Electricity Collector Health" panels could read "No data" at
  the dashboard's default 30-day range immediately after a fresh start (e.g.
  right after clearing and backfilling the datastore), even though the
  exporter's most recent scrape was healthy — a wide range query coarsens
  its evaluation grid, and a single very recent sample can fall in the gap.
  Narrowing the dashboard to a short range (e.g. 1 day) always showed the
  correct status, confirming the data was fine and it was purely a query
  artifact. Since this panel is a "is it up right now" indicator, it doesn't
  make sense for it to depend on the dashboard's selected range at all —
  fixed by pinning it to `timeFrom: 10m`, independent of the rest of the
  dashboard, so it always evaluates against a fine-grained recent window.
- A fresh `backfill-cli.js` run left the meter-reading/cost/rate sparkline
  panels above just as empty as a brand new install, since backfill only
  ever wrote one point per day (the portals' own resolution) and those
  panels are pinned to a 2-day window — one point in 2 days looks like no
  data. Backfill is meant to make a freshly reset instance immediately
  usable, not something that quietly needs a day or two of live scraping
  first. For however much of the requested range falls within the last few
  days, `backfill-cli.js` now writes each of those metrics' value
  repeatedly through the day (every 5 minutes) instead of once — the same
  shape a live scrape record of that day actually has, since the gauge sits
  flat between polls and gets sampled every `scrape_interval` regardless.

## [0.6.0] - 2026-09-19

### Added

- `backfill-cli.js` can now also backfill the cumulative meter reading for
  both services (`israel_utility_water_meter_reading_cubic_meters`,
  `israel_utility_electricity_meter_reading_kwh`), reconstructed by walking
  backward from a known reading and subtracting each day's already-fetched
  consumption. Water's anchor is today's live reading (a best-effort
  estimate); electricity's is a genuine dated reading IEC's own monthly
  response already carries per month, reconstructed independently for each
  month rather than from one guess across the whole range. It's opt-in
  (`--estimated-readings`/`--no-estimated-readings`, or an interactive
  prompt when neither flag is given) since neither can detect a meter swap,
  reset, or house move, and water's figure in particular is an estimate the
  portal never actually reported for that day.
- `israel_utility_water_tariff_normal_rate_ils_per_cubic_meter`: exposes the
  configured below-allowance rate itself (tiered tariff mode only), so the
  redesigned "Water Effective Rate" dashboard panel can flag once the
  blended effective rate has crept above it, without hardcoding a
  household's specific rate into the dashboard. Also backfilled by
  `backfill-cli.js` alongside the other tiered-mode metrics.

### Changed

- Electricity tariff schedule `windows` can now express an overnight span
  directly — e.g. `{ "start": "23:00", "end": "17:00" }` for a night-discount
  plan like SuperPower's "Night Plus". `end` earlier than `start` now means
  the window wraps past midnight into the next day, instead of being
  rejected; previously an overnight window had to be split into two entries
  meeting at `23:59`. A window with `start` equal to `end` is still rejected
  as an ambiguous zero-length window.
- Dropped the tariff schedule's `currency` field. It was accepted and
  defaulted to `'ILS'`, but nothing downstream ever read it —
  `blendedRateForDay` never touched it, and the Grafana dashboard's ILS
  units are hardcoded regardless of what a schedule file says. The water
  tariff config never had an equivalent field either. Existing schedule
  files that still set `currency` continue to load fine; the key is just
  ignored.
- Redesigned the dashboard's Water and Electricity rows for consistency and
  less wasted space:
  - Each row's meter-reading panel now gets most of the row's width (it has
    a sparkline worth seeing); collector health is just an Up/Down badge and
    now only gets a narrow strip instead of half the row.
  - Water: merged "Cost Estimate" and "Forecast Cost Estimate" into one
    "Water Cost" panel (both values, plus a sparkline of the month-to-date
    figure over the dashboard's time range, so the cost trend is visible
    instead of only the current number), dropped the standalone "Tariff
    Threshold" panel (redundant with the dashed "Monthly Limit" line already
    on the consumption graph), and replaced "Effective Rate" with "Water
    Rate vs Normal" — the blended rate as a percentage of the configured
    normal (below-allowance) rate, using the new
    `israel_utility_water_tariff_normal_rate_ils_per_cubic_meter` metric —
    100% means every m3 so far is priced at the normal rate, and the panel
    background turns orange once the month has spilled into the excess
    tier. Six stat panels in that row down to four.
  - Electricity: split the single 4-panel row into an identity row (meter
    reading, health) and a money row (cost estimate, effective rate), matching
    water's layout, and gave "Cost Estimate" and "Effective Rate" the same
    sparkline treatment as water's cost panels.

## [0.5.0] - 2026-09-18

### Added

- `backfill-cli.js` now also backfills the **cost/rate metrics** derived from
  a configured tariff — `israel_utility_water_cost_estimate_ils`,
  `israel_utility_water_tariff_threshold_cubic_meters`,
  `israel_utility_water_effective_rate_ils_per_cubic_meter`,
  `israel_utility_electricity_cost_estimate_ils`, and
  `israel_utility_electricity_effective_rate_ils_per_kwh` — not just the raw
  consumption numbers the utility APIs report directly. Priced with today's
  tariff config, the same way the live collectors price the current
  month/day; see the README's "Historical data backfill" section for the
  caveat this implies for a historical period whose tariff has since
  changed. The water forecast metrics have no historical equivalent and are
  still never backfilled.
- The water dashboard's "Weekly / Monthly Water Consumption vs Forecast"
  panel now plots a dashed red "Monthly Limit" line
  (`israel_utility_water_tariff_threshold_cubic_meters`), only present in
  `WATER_TARIFF_MODE=tiered`. Drawn as a live query rather than a value
  baked into the dashboard, so it always tracks whatever household
  size/allowance is actually configured instead of going stale if that
  changes.
- `WaterMonthlyConsumptionOverBudget` in `prometheus/alerts.yml` now
  compares directly against `israel_utility_water_tariff_threshold_cubic_meters`
  in tiered mode instead of a hardcoded illustrative number, so it no
  longer needs manual sizing to your household. It simply never fires in
  flat mode, where that metric doesn't exist.

### Fixed

- `waterTariffThreshold` multiplied `WATER_TARIFF_HOUSEHOLD_SIZE` directly by
  the per-person allowance, missing the law's floor: every housing unit is
  guaranteed at least a 2-person allowance regardless of registered
  headcount. Verified against Yuval Lim's published tariff text — "לא פחות
  מ-14 מ"ק לחודשיים ליחידת דיור גם אם מתגוררים בה דרך קבע פחות משתי נפשות"
  (not less than 14 m3/2 months per housing unit, even with fewer than two
  permanent residents) — 14/2 = 7, exactly 2x the 3.5 m3/month per-person
  figure quoted alongside it. Now `max(WATER_TARIFF_HOUSEHOLD_SIZE, 2) x
  WATER_TARIFF_ALLOWANCE_PER_PERSON_CUBIC_METERS`.
- Docs now call out, prompted by an actual misconfiguration attempt:
  published tariffs often quote the allowance per *two months* (Yuval Lim:
  "7 מ"ק לנפש לחודשיים") while `WATER_TARIFF_ALLOWANCE_PER_PERSON_CUBIC_METERS`
  needs the monthly figure (3.5) to match the monthly consumption metric
  it's compared against.

## [0.4.0] - 2026-09-18

### Added

- Volume-tiered water cost estimation (`WATER_TARIFF_MODE=tiered`), modeling
  the subsidized-allowance-then-higher-rate structure Israeli water tariffs
  actually use instead of a single flat price. Configure
  `WATER_TARIFF_EXCESS_PRICE_PER_CUBIC_METER`, `WATER_TARIFF_HOUSEHOLD_SIZE`,
  and `WATER_TARIFF_ALLOWANCE_PER_PERSON_CUBIC_METERS` alongside the existing
  `WATER_PRICE_PER_CUBIC_METER` (now doubling as the below-allowance rate).
  Adds `israel_utility_water_tariff_threshold_cubic_meters` and
  `israel_utility_water_effective_rate_ils_per_cubic_meter`, and two new
  Grafana panels, so the computed threshold and blended rate are visible
  rather than hidden inside the cost figure.
- `israel_utility_water_cost_estimate_forecast_ils`: the portal's own
  month-end consumption forecast, priced the same way (flat or tiered) as
  the existing month-to-date cost estimate, plus a matching Grafana panel.

### Fixed

- `prometheus/prometheus.yml.example`'s `scrape_interval` was `5m`, exactly
  matching Prometheus's default 5m query `lookback_delta`. Any scrape landing
  even a few seconds late left range queries — what Grafana's Stat panels use
  by default — with no sample inside the lookback window, so a "current
  value" panel like the cost estimate would intermittently render as
  unconfigured/no-data, differently depending on the selected time range.
  Lowered to `1m`, and the cost-estimate/effective-rate Stat panels now
  query `instant: true` so they always reflect the latest value regardless
  of the dashboard's selected time range. This is unrelated to how slowly
  the underlying water/electricity data itself updates — see "Behavior
  worth knowing" in the README if you deliberately want a slower
  `scrape_interval` than 5m.
- Backfilled monthly consumption is now a **running month-to-date total,
  one sample per day**, instead of a single point on the 1st carrying the
  whole month's eventual total. The old approach misrepresented every day
  before the month's end (a query on, say, the 5th would have shown the
  full month's final number, not month-to-date-so-far) and was also easy to
  mistake for missing data: one point every ~30 days only shows up if a
  dashboard's time range happens to reach back to that exact date. Derived
  from the same per-day data already fetched for the daily figure — for
  water this widens the daily fetch to start from the 1st of the month
  containing `--from` (so a mid-month start still has the whole month's
  earlier days to sum), and drops the separate `/consumption/monthly` call
  entirely; for electricity it reuses the daily breakdown already inside
  the `MONTHLY` resolution response instead of a single `totalForPeriod`.

## [0.3.3] - 2026-09-18

### Fixed

- Electricity's daily backfill no longer calls `DAILY` resolution at all.
  Verified against a live account: `DAILY` resolution doesn't return a date
  range — `fromDate` selects a single calendar day, and the response is
  that day's 15-minute sub-readings, not one row per day across the
  requested range. `MONTHLY` resolution, called once per month (already
  needed for the monthly figure), already returns one period per calendar
  day within the month with each day's real total, so daily and monthly
  data now both come from the same call.
- Fixed a date-attribution bug in that period parsing: `interval` is a true
  UTC timestamp, and naively slicing it to `YYYY-MM-DD` misattributes any
  entry in the last hours of the UTC day to the previous calendar day in a
  timezone ahead of UTC (Israel included). Now parsed as a real instant and
  converted to the local calendar date.
- The Grafana dashboard's daily/weekly/monthly consumption panels now set
  `spanNulls`/`lineInterpolation: stepAfter`, so once-a-day backfilled
  points render as a connected step chart instead of isolated dots (the
  default "Connect null values: Never" doesn't bridge gaps that wide).

## [0.3.2] - 2026-09-18

### Fixed

- The backfill CLI now supports `REMOTE_WRITE_EXTRA_LABELS` (comma-separated
  `key=value` pairs, e.g. `job=israel-utility-exporter,instance=host:9877`)
  applied to every backfilled series. Without it, a backfilled series had no
  `job`/`instance` label — those are assigned by Prometheus at scrape time,
  not carried in `/metrics` — so it landed as a *different* series from the
  one live scrapes produce for the same meter/contract, splitting the graph
  in two. Parsed independently of `REMOTE_WRITE_URL` so a `--dry-run`
  preview shows the same labels a real run would write.
- Electricity backfill now fetches daily consumption in `DAILY_LOOKBACK_DAYS`
  chunks instead of one call spanning the whole range. IEC's
  `RemoteReadingRange` doesn't reliably return one row per day for a wide
  `fromDate` — observed in practice returning many rows all dated to
  `fromDate` itself rather than the requested range, so a wide backfill
  recovered close to nothing.

## [0.3.1] - 2026-09-18

### Fixed

- The backfill hint added in 0.3.0 now only logs on a genuine first run —
  when a collector starts up and sees it has never recorded any data yet
  (tracked per-collector in a small persisted state file) — instead of on
  every single startup. Its wording is also much shorter, and no longer
  suggests two redundant ways to run the same command.

## [0.3.0] - 2026-09-17

### Added

- A `backfill` CLI (`npm run backfill` / `node dist/backfill-cli.js`) that
  fetches historical daily/weekly/monthly consumption from the IEC and RYM
  Pro APIs and pushes it to a `REMOTE_WRITE_URL` via the standard Prometheus
  remote_write protocol (protobuf + Snappy), so it works with any compliant
  receiver (Prometheus with `--web.enable-remote-write-receiver`, Thanos,
  Cortex, Mimir, or any other remote_write-compatible TSDB). Supports
  `--dry-run`, HTTP Basic/Bearer auth, and custom CA/client-cert/skip-verify
  TLS options. See the README's "Historical data backfill" section.
- Both collectors now log a one-time hint about the backfill CLI on a fresh
  start, so operators discover it without having to read the README first.

### Changed

- `dateToEpochSeconds` (used for both `*_covers_timestamp_seconds` gauges)
  is now a single shared implementation (`src/time/day.ts`) instead of two
  independently duplicated copies in the water and electricity collectors.

## [0.2.2] - 2026-09-16

### Added

- CI now runs `promtool check metrics` against a live `/metrics` response
  (`scripts/check-metrics-format.mjs`) on every push, so the exposition
  format is validated by Prometheus's own tooling instead of just asserted.
  README's Metrics section notes this and the naming/exporter best practices
  the metrics already followed.

### Fixed

- The electricity login CLI now reports "sms" instead of "email" when IEC's
  registered OTP factor is Okta type "email" but points at IEC's own
  internal email-to-SMS gateway (`sns.iec.co.il`) — the code always arrived
  by text, the prompt just described it wrong.

## [0.2.1] - 2026-09-16

### Changed

- `docker-compose.yml`'s exporter service now sets its environment variables
  directly under `environment:` (optional ones left commented for reference)
  instead of a separate `.env` file, which is gone along with `.env.example`.
- The HTTP server now starts before the water/electricity collectors run
  their first poll, instead of after — so `/healthz` and `/metrics` come up
  immediately rather than waiting on a slow or rate-limited portal. A
  collector's own poll errors still can't crash it, but a genuinely fatal
  startup failure (a corrupt state file, an invalid tariff schedule) now
  closes the server and exits non-zero, instead of leaving a falsely
  "healthy" exporter running with that collector silently dead.
- The Dockerfile's `HEALTHCHECK` no longer falls back to HTTPS when TLS is
  configured — it assumes plain HTTP; override it yourself if you enable
  `WEB_CONFIG_FILE`'s TLS support. Also dropped a redundant `|| exit 1`
  (`wget --spider` already exits non-zero on failure).

## [0.2.0] - 2026-09-16

### Added

- Optional TLS and HTTP Basic Auth for the exporter's own HTTP server,
  configured via a `WEB_CONFIG_FILE` YAML file (`tls_server_config`,
  `basic_auth_users`, bcrypt-hashed) — see `web-config.yml.example`. `/healthz`
  stays unauthenticated over the same scheme so the container `HEALTHCHECK`
  never needs credentials.
- `LOG_LEVEL=debug` diagnostics for the electricity login CLI: the full list
  of OTP factors Okta offers, and a warning if the factor it actually
  verified disagrees with the one requested.

### Changed

- `docker-compose.yml`'s exporter service no longer publishes its port to the
  host — Prometheus already reaches it over the internal Compose network —
  and only pulls the published `image:` instead of also building from source.
- The Dockerfile's `HEALTHCHECK` now runs `wget --spider` (falling back to
  HTTPS when TLS is configured) instead of a custom Node script, and `tini`
  is now PID 1 for proper signal forwarding and zombie reaping.

## [0.1.0] - 2026-09-16

### Added

- First version: a Prometheus exporter for Israeli water (Read Your Meter Pro)
  and electricity (IEC) consumption, with either collector independently
  optional.
- Water collector: cumulative meter reading, daily/weekly/monthly consumption,
  month-end forecast — ported from `homebridge-read-your-meter-pro`'s
  publish-lag handling, weekly window modes, and rate-limit retry logic.
- Electricity collector: cumulative meter reading, daily and monthly
  consumption — ported from `homebridge-iec-electricity`'s Okta PKCE/OTP login
  and token refresh, plus a new daily-resolution fetch not present in the
  source plugin.
- A one-time interactive login CLI for the electricity collector
  (`node dist/electricity/login-cli.js --id <israeli-id>`), since IEC's OTP
  login can't happen inside an unattended container.
- Optional cost estimation: a flat ILS/kWh or ILS/m³ price, or (electricity
  only) a time-of-use tariff schedule modelling plans like "70% off
  17:00-23:00" as a duration-weighted blended daily rate.
- Metadata info metrics for the water meter serial and electricity contract
  number/address.
- A ready-to-use Grafana dashboard (`grafana/`) and Prometheus alert rules
  (`prometheus/alerts.yml`), both wired up automatically by `docker-compose.yml`.
- Multi-arch (amd64/arm64) Docker image published to Docker Hub as
  `aransh/israel-utility-exporter`.

[Unreleased]: https://github.com/Aransh/israel-utility-exporter/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/Aransh/israel-utility-exporter/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Aransh/israel-utility-exporter/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Aransh/israel-utility-exporter/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Aransh/israel-utility-exporter/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Aransh/israel-utility-exporter/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/Aransh/israel-utility-exporter/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/Aransh/israel-utility-exporter/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Aransh/israel-utility-exporter/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Aransh/israel-utility-exporter/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/Aransh/israel-utility-exporter/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Aransh/israel-utility-exporter/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Aransh/israel-utility-exporter/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Aransh/israel-utility-exporter/releases/tag/v0.1.0
