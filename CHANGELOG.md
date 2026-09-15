# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released version has a matching `vX.Y.Z` git tag; the release workflow uses
the section below the matching heading as the GitHub release notes, so keep the
headings in the `## [x.y.z] - YYYY-MM-DD` form.

## [Unreleased]

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

[Unreleased]: https://github.com/Aransh/israel-utility-exporter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Aransh/israel-utility-exporter/releases/tag/v0.1.0
