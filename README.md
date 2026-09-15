# israel-utility-exporter

[![build](https://img.shields.io/github/actions/workflow/status/Aransh/israel-utility-exporter/build.yml?branch=main&logo=github&label=build)](https://github.com/Aransh/israel-utility-exporter/actions/workflows/build.yml)
[![docker](https://img.shields.io/docker/v/aransh/israel-utility-exporter?sort=semver&logo=docker&logoColor=white&label=docker)](https://hub.docker.com/r/aransh/israel-utility-exporter)
[![license](https://img.shields.io/github/license/Aransh/israel-utility-exporter?color=blue)](LICENSE)

A [Prometheus](https://prometheus.io) exporter for Israeli household water
([Read Your Meter Pro](https://rym-pro.com), ARAD meters) and electricity
([IEC](https://www.iec.co.il)) consumption data — with a ready-to-use Grafana
dashboard and Prometheus alert rules included.

Unofficial, and not affiliated with Arad Group, any water corporation, the
Israel Electric Company, Prometheus or Grafana Labs.

## Why this exists

Two excellent Homebridge plugins already read this data —
[homebridge-read-your-meter-pro](https://github.com/Aransh/homebridge-read-your-meter-pro)
(water) and
[homebridge-iec-electricity](https://github.com/shayshahar/homebridge-iec-electricity)
(electricity) — but HomeKit has no concept of history: you get today's
number in the Home app and nothing else. This exporter polls the same two
APIs and puts the data in Prometheus instead, so Grafana can show you what
Home never could: **usage over weeks and months, cost trends, and alerts on
your own terms.**

Both collectors are independently optional — run this with just water, just
electricity, or both.

## Quick start

```bash
git clone https://github.com/Aransh/israel-utility-exporter.git
cd israel-utility-exporter
cp .env.example .env
# edit .env: enable water and/or electricity, fill in credentials
docker compose up -d
```

This starts three containers: the exporter, Prometheus (pre-loaded with the
alert rules in `prometheus/alerts.yml`), and Grafana (pre-provisioned with the
dashboard in `grafana/provisioning/dashboards/files/dashboard.json`). Open
Grafana at http://localhost:3000 (default login `admin` / `admin`) — the
"Israel Utility Exporter" dashboard is already there.

If you only want the exporter itself (bring your own Prometheus/Grafana):

```bash
docker run -d --name israel-utility-exporter \
  -p 9877:9877 \
  -v israel-utility-exporter-data:/data \
  -e WATER_ENABLED=true \
  -e WATER_EMAIL=you@example.com \
  -e WATER_PASSWORD='your-portal-password' \
  aransh/israel-utility-exporter:latest
```

Then point Prometheus at it — see `prometheus/prometheus.yml.example` and
`prometheus/alerts.yml`.

## Setting up each collector

### Water (Read Your Meter Pro)

Needs an account at [rym-pro.com](https://rym-pro.com) — registration fails if
your meter isn't an ARAD unit or your water corporation hasn't migrated to the
Pro portal; verify you can log in on the web first. Set:

```
WATER_ENABLED=true
WATER_EMAIL=you@example.com
WATER_PASSWORD=your-portal-password
```

That's it — no further setup. The exporter logs in on startup and keeps the
session token in `DATA_DIR`.

### Electricity (IEC)

IEC login needs your Israeli ID and an SMS/email OTP, which can't be entered
inside an unattended container. It's a one-time (well, occasional) manual
step:

```bash
docker run --rm -it -v israel-utility-exporter-data:/data \
  aransh/israel-utility-exporter node dist/electricity/login-cli.js --id 123456789
```

This prompts for the OTP code, then writes a refresh-capable token into the
same volume the main container reads from. Set:

```
ELECTRICITY_ENABLED=true
ELECTRICITY_ID=123456789
```

Then start (or restart) the exporter — it loads and automatically refreshes
that token from then on. `israel_utility_electricity_token_expires_timestamp_seconds`
and the `ElectricityTokenExpiringSoon` alert give warning before the refresh
token itself eventually needs a fresh login (IEC's own refresh tokens are
long-lived, but not eternal).

## Configuration

At least one of `WATER_ENABLED` / `ELECTRICITY_ENABLED` must be `true` — the
exporter exits immediately with an error otherwise rather than serving an
empty `/metrics` silently.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `9877` | HTTP port for `/metrics` and `/healthz`. |
| `DATA_DIR` | `/data` | Where session/token state is persisted. Mount a volume here. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `WATER_ENABLED` | `false` | Set `true` to enable the water collector. |
| `WATER_EMAIL` / `WATER_PASSWORD` | — | RYM Pro portal credentials. Required if `WATER_ENABLED`. |
| `WATER_POLL_INTERVAL_MINUTES` | `90` | Floored at 15 — the meter itself updates at most hourly, and polling faster risks the portal's rate limit. |
| `WATER_WEEKLY_WINDOW` | `sunday` | `sunday` \| `monday` \| `rolling` — see [Behavior worth knowing](#behavior-worth-knowing). |
| `WATER_PRICE_PER_CUBIC_METER` | — | ILS. If set, enables `israel_utility_water_cost_estimate_ils`. |
| `ELECTRICITY_ENABLED` | `false` | Set `true` to enable the electricity collector. |
| `ELECTRICITY_ID` | — | Your 9-digit Israeli ID. Required if `ELECTRICITY_ENABLED`. |
| `ELECTRICITY_TOKEN_FILE` | `$DATA_DIR/iec-token.json` | Written by the login CLI; loaded/refreshed by the collector. |
| `ELECTRICITY_POLL_INTERVAL_MINUTES` | `60` | IEC's own data lags 1-2 days regardless of poll frequency — see below. |
| `ELECTRICITY_TARIFF_MODE` | `flat` | `flat` \| `schedule`. See [Cost estimation](#cost-estimation). |
| `ELECTRICITY_PRICE_PER_KWH` | — | ILS. Used when `flat`. |
| `ELECTRICITY_TARIFF_SCHEDULE_FILE` | — | Path to a JSON schedule file. Used when `schedule`. See `tariff-schedule.example.json`. |

## Cost estimation

Both collectors can turn consumption into an estimated cost — entirely
optional, and off by default. Israel doesn't publish tariffs via any API, so
you supply the price yourself:

- **Flat pricing** (`WATER_PRICE_PER_CUBIC_METER`, `ELECTRICITY_PRICE_PER_KWH`):
  one price × the consumption figure. The right choice if you're not on a
  time-of-use electricity plan, or want a simple average.
- **Time-of-use schedule** (electricity only, `ELECTRICITY_TARIFF_MODE=schedule`):
  models Israeli "taoz" plans like "70% off 17:00-23:00" offered by several
  private electricity suppliers. See `tariff-schedule.example.json`:

  ```json
  {
    "currency": "ILS",
    "baseRatePerKwh": 0.6115,
    "windows": [
      { "days": ["sun", "mon", "tue", "wed", "thu"], "start": "17:00", "end": "23:00", "discountPercent": 70 },
      { "days": ["fri", "sat"], "start": "00:00", "end": "23:59", "discountPercent": 20 }
    ]
  }
  ```

  **Read this before trusting the number it produces.** IEC's own API never
  reports consumption finer than a whole published day's total kWh — there is
  no hourly breakdown to attribute to specific tariff windows (confirmed
  against `py-iec-api`'s and the Home Assistant IEC integration's source: they
  synthesize 24 even hourly buckets from a daily/monthly total when finer data
  is missing, rather than having real per-hour readings — see
  `THIRD-PARTY-NOTICES.md`). So instead of pretending to know when in the day
  you used electricity, the exporter computes a **duration-weighted blended
  rate for that calendar day** — e.g. 6 discounted hours + 18 base hours,
  averaged — and multiplies the day's total kWh by that single number. This
  assumes consumption is roughly even across the day. It is a genuinely useful
  estimate for comparing plans or tracking a trend, but it is **not a bill
  reconstruction** — expect it to diverge from your actual invoice, more so the
  more your usage is concentrated in or out of the discount window.
  `israel_utility_electricity_effective_rate_ils_per_kwh` exposes the blended
  rate itself, so the assumption is visible rather than hidden inside a cost
  figure.

  Water has no time-of-use concept in Israel — tariffs are volume-tiered (a
  subsidized allowance per person, then a higher rate), not time-based — so
  its cost estimate is flat-price-only.

## Metrics

Namespace `israel_utility`. All gauges; a poll that fails or finds nothing new
published simply leaves them at their last value (Prometheus keeps serving
it), so a portal outage never shows up as a false zero.

**Water** (labels `meter_id`, `meter_serial`):

| Metric | Meaning |
| --- | --- |
| `israel_utility_water_meter_reading_cubic_meters` | Cumulative meter reading. |
| `israel_utility_water_consumption_daily_liters` | Consumption for the most recently published day. |
| `israel_utility_water_consumption_daily_covers_timestamp_seconds` | Which calendar day that is — see the publish-lag note below. |
| `israel_utility_water_consumption_weekly_liters` | Consumption over the configured weekly window. |
| `israel_utility_water_consumption_weekly_days_counted` / `..._elapsed` | How much of the weekly window is actually published vs. begun. |
| `israel_utility_water_consumption_monthly_liters` | Month-to-date consumption. |
| `israel_utility_water_consumption_forecast_liters` | The portal's own month-end forecast. |
| `israel_utility_water_cost_estimate_ils` | Month-to-date cost, if `WATER_PRICE_PER_CUBIC_METER` is set. |
| `israel_utility_water_meter_info` | Always 1; carries `meter_serial` for dashboard joins. |
| `israel_utility_water_scrape_success` / `..._last_success_timestamp_seconds` / `..._consecutive_failures` | Collector health. |

**Electricity** (label `contract_id`):

| Metric | Meaning |
| --- | --- |
| `israel_utility_electricity_meter_reading_kwh` | Cumulative meter reading. |
| `israel_utility_electricity_consumption_daily_kwh` | Consumption for the most recently published day. |
| `israel_utility_electricity_consumption_daily_covers_timestamp_seconds` | Which calendar day that is. |
| `israel_utility_electricity_consumption_monthly_kwh` | Month-to-date consumption. |
| `israel_utility_electricity_effective_rate_ils_per_kwh` | Today's blended rate — schedule tariff mode only. |
| `israel_utility_electricity_cost_estimate_ils` | Estimated cost of the newest published day, if priced. |
| `israel_utility_electricity_token_expires_timestamp_seconds` | When the current session token expires. |
| `israel_utility_electricity_contract_info` | Always 1; carries `contract_number`/`address` for dashboard joins. |
| `israel_utility_electricity_scrape_success` / `..._last_success_timestamp_seconds` / `..._consecutive_failures` | Collector health. |

Plus `israel_utility_exporter_build_info{version="..."}`.

## Grafana dashboard & Prometheus alerts

- `grafana/provisioning/dashboards/files/dashboard.json` — auto-provisioned by
  `docker-compose.yml`, or import it manually into your own Grafana. Two
  rows, Water and Electricity, each showing the cumulative meter trend,
  daily/monthly consumption over time, cost estimate, and collector health —
  a row simply shows "No data" if that collector is disabled.
- `prometheus/alerts.yml` — two rule groups:
  - **Health alerts** (safe to run as shipped): the exporter being
    unreachable, either collector going stale (no successful poll in 6h) or
    failing repeatedly, and the electricity token nearing expiry.
  - **Budget alert examples** (illustrative thresholds — size them to your
    own household before relying on them): daily/monthly consumption over a
    limit, based on Israel's ~400 L/person/day and ~3.5 m³ (3500 L)/person/month
    subsidized-allocation guidance.

## Behavior worth knowing

- **The daily figure isn't always today's.** Both portals publish a day's
  reading with a lag — sometimes a day or two. Both collectors look back up
  to 7 days and report the newest day actually published, and
  `*_covers_timestamp_seconds` tells you which day that is. A null/unpublished
  reading is never reported as zero consumption.
- **`WATER_WEEKLY_WINDOW=rolling` vs. `sunday`/`monday`**: the calendar-week
  options reset on that weekday (so early in a new week the total is small
  because little has been published yet, not because usage was low); `rolling`
  is the trailing 7 days and never resets, so a threshold on it means the same
  thing every day.
- **Electricity data is inherently coarse.** IEC updates meter data roughly
  every 1-2 days regardless of how often you poll — `ELECTRICITY_POLL_INTERVAL_MINUTES`
  below ~60 gains nothing.
- **A rejected water password stops that collector, not the exporter.**
  Retrying a bad password on a timer risks the portal's login lockout, so it
  logs an error and stops polling water — fix `WATER_EMAIL`/`WATER_PASSWORD`
  and restart. Electricity works the same way for an unrecoverable token: it
  reports the problem and waits for you to re-run the login CLI, rather than
  crash-looping the whole container.
- **Everything else (rate limits, transient errors) holds the last known
  reading** and keeps retrying on the next poll, rather than showing a gap.

## Development

```bash
npm install
npm run lint
npm run build
npm test          # lint + build + unit tests, against faked APIs — no real credentials needed
```

Unit tests stub `globalThis.fetch` with fake portal/IEC servers (see
`test/rympro-client.test.ts`, `test/iec-client.test.ts`) rather than hitting
the real APIs.

To verify field names against your own account if something looks wrong, run
with `LOG_LEVEL=debug` — both collectors log the raw shape of every API
response they use at debug level.

### Releasing

1. Bump the version: `npm version 1.0.0 --no-git-tag-version` (updates
   `package.json` and `package-lock.json` together), or edit the version
   in-place in those same two files.
2. Update [`CHANGELOG.md`](CHANGELOG.md) with the relevant changes, under a
   `## [1.0.0] - YYYY-MM-DD` heading. Commit and merge both.
3. Actions → **docker-release** → *Run workflow*. Give it the tag (`v1.0.0`),
   tick **prerelease** for anything like `v1.0.0-beta.2`, and run it.

The workflow re-runs the full build, builds and pushes a multi-arch
(`linux/amd64`, `linux/arm64`) image to
[Docker Hub](https://hub.docker.com/r/aransh/israel-utility-exporter) tagged
with the version (and `latest`, for a non-prerelease), then creates the git
tag and GitHub release with that version's `CHANGELOG.md` section as its notes
verbatim. Tick **dry run** to build without pushing or releasing anything.

## Credits

The water and electricity clients are ports of code from
[homebridge-read-your-meter-pro](https://github.com/Aransh/homebridge-read-your-meter-pro)
(same author, MIT) and
[homebridge-iec-electricity](https://github.com/shayshahar/homebridge-iec-electricity)
(Shay Shahar, Apache-2.0) / [py-iec-api](https://github.com/GuyKh/py-iec-api)
(Guy Khmelnitsky, Apache-2.0). Full attribution in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## License

MIT
