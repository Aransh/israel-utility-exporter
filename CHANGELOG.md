# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released version has a matching `vX.Y.Z` git tag; the release workflow uses
the section below the matching heading as the GitHub release notes, so keep the
headings in the `## [x.y.z] - YYYY-MM-DD` form.

## [Unreleased]

## [0.2.2] - 2026-09-16

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

[Unreleased]: https://github.com/Aransh/israel-utility-exporter/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/Aransh/israel-utility-exporter/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Aransh/israel-utility-exporter/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Aransh/israel-utility-exporter/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Aransh/israel-utility-exporter/releases/tag/v0.1.0
