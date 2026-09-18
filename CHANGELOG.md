# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released version has a matching `vX.Y.Z` git tag; the release workflow uses
the section below the matching heading as the GitHub release notes, so keep the
headings in the `## [x.y.z] - YYYY-MM-DD` form.

## [Unreleased]

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

[Unreleased]: https://github.com/Aransh/israel-utility-exporter/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/Aransh/israel-utility-exporter/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/Aransh/israel-utility-exporter/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Aransh/israel-utility-exporter/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Aransh/israel-utility-exporter/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/Aransh/israel-utility-exporter/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Aransh/israel-utility-exporter/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Aransh/israel-utility-exporter/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Aransh/israel-utility-exporter/releases/tag/v0.1.0
