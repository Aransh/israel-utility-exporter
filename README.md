<p align="center">
  <img src="docs/logo.png" alt="israel-utility-exporter logo" width="120" height="120">
</p>

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
# edit docker-compose.yml: under the israel-utility-exporter service's
# `environment:`, enable water and/or electricity and fill in credentials
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
same volume the main container reads from. The prompt names the channel Okta
reports (`sms`, `email`, ...) for the factor it actually requested — if that
ever disagrees with where the code really arrived, rerun with
`LOG_LEVEL=debug` for a line listing every available factor plus a warning if
Okta's own responses disagree with each other. Set:

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
| `WEB_CONFIG_FILE` | — | Path to a YAML file enabling TLS and/or Basic Auth. See [TLS & Basic Auth](#tls--basic-auth) below. |
| `VAT_PERCENT` | `18` | Grosses up every configured price below by this percentage — enter the pre-VAT rate. See [Cost estimation](#cost-estimation). |
| `WATER_ENABLED` | `false` | Set `true` to enable the water collector. |
| `WATER_EMAIL` / `WATER_PASSWORD` | — | RYM Pro portal credentials. Required if `WATER_ENABLED`. |
| `WATER_POLL_INTERVAL_MINUTES` | `90` | Floored at 15 — the meter itself updates at most hourly, and polling faster risks the portal's rate limit. |
| `WATER_WEEKLY_WINDOW` | `sunday` | `sunday` \| `monday` \| `rolling` — see [Behavior worth knowing](#behavior-worth-knowing). |
| `WATER_TARIFF_MODE` | `flat` | `flat` \| `tiered`. See [Cost estimation](#cost-estimation). |
| `WATER_PRICE_PER_CUBIC_METER` | — | ILS. Used when `flat`; also the tiered mode's below-allowance rate. If set (flat) or fully configured (tiered), enables `israel_utility_water_cost_estimate_ils`. |
| `WATER_TARIFF_EXCESS_PRICE_PER_CUBIC_METER` | — | ILS. Used when `tiered` — the rate above the household's allowance. |
| `WATER_TARIFF_HOUSEHOLD_SIZE` | — | Positive integer. Used when `tiered` — number of people registered on the water account. Treated as at least 2 — see [Cost estimation](#cost-estimation). |
| `WATER_TARIFF_ALLOWANCE_PER_PERSON_CUBIC_METERS` | — | m3/person/**month**. Used when `tiered` — see [Cost estimation](#cost-estimation) for a monthly-vs-bimonthly gotcha. |
| `ELECTRICITY_ENABLED` | `false` | Set `true` to enable the electricity collector. |
| `ELECTRICITY_ID` | — | Your 9-digit Israeli ID. Required if `ELECTRICITY_ENABLED`. |
| `ELECTRICITY_TOKEN_FILE` | `$DATA_DIR/iec-token.json` | Written by the login CLI; loaded/refreshed by the collector. |
| `ELECTRICITY_POLL_INTERVAL_MINUTES` | `60` | IEC's own data lags 1-2 days regardless of poll frequency — see below. |
| `ELECTRICITY_TARIFF_MODE` | `flat` | `flat` \| `schedule`. See [Cost estimation](#cost-estimation). |
| `ELECTRICITY_PRICE_PER_KWH` | — | ILS. Used when `flat`. |
| `ELECTRICITY_TARIFF_SCHEDULE_FILE` | — | Path to a JSON schedule file. Used when `schedule`. See `tariff-schedule.example.json`. |
| `REMOTE_WRITE_URL` | — | A Prometheus remote_write endpoint. Only used by the [backfill CLI](#historical-data-backfill), not the running exporter. |
| `REMOTE_WRITE_EXTRA_LABELS` | — | Comma-separated `key=value` pairs (e.g. `job=israel-utility-exporter,instance=host:9877`) applied to every backfilled series — **set this to match your scrape config's `job`/`instance`**, or backfilled and live-scraped data land as separate series. |
| `REMOTE_WRITE_USERNAME` / `REMOTE_WRITE_PASSWORD` | — | HTTP Basic auth for `REMOTE_WRITE_URL`. Set together. |
| `REMOTE_WRITE_BEARER_TOKEN` | — | Bearer token auth for `REMOTE_WRITE_URL`. Mutually exclusive with Basic auth. |
| `REMOTE_WRITE_TIMEOUT_MS` | `30000` | Per-request timeout for the remote_write POST. |
| `REMOTE_WRITE_TLS_CA_FILE` | — | Path to a custom CA bundle (PEM), for a receiver with a private/self-signed certificate. |
| `REMOTE_WRITE_TLS_CERT_FILE` / `REMOTE_WRITE_TLS_KEY_FILE` | — | Client certificate/key (PEM) for mTLS. Set together. |
| `REMOTE_WRITE_TLS_INSECURE_SKIP_VERIFY` | `false` | Disables certificate verification. Testing/self-signed use only — never for production. |

## TLS & Basic Auth

By default the exporter serves plain, unauthenticated HTTP — fine on a
private network, but this data is personal, so set `WEB_CONFIG_FILE` if
`/metrics` is reachable beyond that. Copy `web-config.yml.example` to
`web-config.yml`, fill in what applies, and point `WEB_CONFIG_FILE` at it
(e.g. `/data/web-config.yml`):

```yaml
tls_server_config:
  cert_file: /data/tls/fullchain.pem
  key_file: /data/tls/privkey.pem
basic_auth_users:
  admin: $2y$10$replace-with-a-real-bcrypt-hash
```

Both sections are optional and independent. Passwords are bcrypt hashes, not
plaintext — generate one with `htpasswd -nBC 10 "" | tr -d ':\n'`. `/healthz`
is always served unauthenticated, but still over whatever scheme `/metrics`
uses; `/metrics` and `/` are protected when configured. The exporter reads
the config file and cert/key once at startup — restart it after rotating
certs or changing the file.

Enabling TLS means the image's own `HEALTHCHECK` (plain HTTP) no longer
matches — override it in your own compose file or `docker run`, e.g.
`wget --quiet --tries=1 --spider --no-check-certificate https://localhost:$PORT/healthz`.

## Cost estimation

Both collectors can turn consumption into an estimated cost — entirely
optional, and off by default. Israel doesn't publish tariffs via any API, so
you supply the price yourself.

**Enter the pre-VAT rate — `VAT_PERCENT` (default `18`) grosses it up
automatically** for every configured price
(`WATER_PRICE_PER_CUBIC_METER`, `WATER_TARIFF_EXCESS_PRICE_PER_CUBIC_METER`,
`ELECTRICITY_PRICE_PER_KWH`, a schedule file's `baseRatePerKwh`), on both the
live collectors and the backfill CLI. Electricity bills already quote the
pre-VAT rate; **water tariffs are published VAT-inclusive**, so back that
number out first — see [docs/cost-estimation.md](docs/cost-estimation.md) for
a worked example. Set `VAT_PERCENT=0` to enter an already VAT-inclusive rate
directly. The resulting cost/rate metrics (see [Metrics](#metrics)) are all
VAT-inclusive, as is anything the backfill CLI writes for them.

- **Flat pricing** (`WATER_PRICE_PER_CUBIC_METER`, `ELECTRICITY_PRICE_PER_KWH`):
  one price × the consumption figure.
- **Time-of-use schedule** (electricity only, `ELECTRICITY_TARIFF_MODE=schedule`):
  models Israeli "taoz" plans like "70% off 17:00-23:00" — see
  `tariff-schedule.example.json`. IEC's API has no hourly breakdown, so this
  is a **duration-weighted blended daily rate**, not a bill reconstruction —
  see [docs/cost-estimation.md](docs/cost-estimation.md) for the detail and
  its limits.
- **Volume-tiered pricing** (water only, `WATER_TARIFF_MODE=tiered`): a
  subsidized per-person allowance, then a higher rate beyond it. Configure
  `WATER_TARIFF_EXCESS_PRICE_PER_CUBIC_METER`, `WATER_TARIFF_HOUSEHOLD_SIZE`,
  and `WATER_TARIFF_ALLOWANCE_PER_PERSON_CUBIC_METERS` alongside
  `WATER_PRICE_PER_CUBIC_METER` (the below-allowance rate). This month's
  threshold is `max(WATER_TARIFF_HOUSEHOLD_SIZE, 2) x
  WATER_TARIFF_ALLOWANCE_PER_PERSON_CUBIC_METERS` (Israeli law guarantees
  every housing unit at least a 2-person allowance). Get the real numbers
  from your own water corporation's published tariff — see
  [docs/cost-estimation.md](docs/cost-estimation.md) for units to watch
  (monthly vs. bimonthly allowance figures, the VAT convention) and a worked
  example.

## Metrics

Namespace `israel_utility`. All gauges; a poll that fails or finds nothing new
published simply leaves them at their last value (Prometheus keeps serving
it), so a portal outage never shows up as a false zero.

Follows Prometheus's official [metric naming](https://prometheus.io/docs/practices/naming/)
and [exporter](https://prometheus.io/docs/instrumenting/writing_exporters/)
conventions — base units, a `build_info` metric, gauges rather than counters
for absolute readings from an external API — and CI runs `promtool check
metrics` against a live `/metrics` response on every push to keep the
exposition format itself verified by Prometheus's own tooling.

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
| `israel_utility_water_tariff_threshold_cubic_meters` | This month's subsidized-rate threshold. Tiered tariff mode only. |
| `israel_utility_water_effective_rate_ils_per_cubic_meter` | This month-to-date consumption's blended ILS/m3 rate, including VAT. Tiered tariff mode only. |
| `israel_utility_water_tariff_normal_rate_ils_per_cubic_meter` | The configured below-allowance rate itself, including VAT, for comparison against the effective rate above. Tiered tariff mode only. |
| `israel_utility_water_cost_estimate_ils` | Month-to-date cost, if priced (flat or tiered), including VAT. |
| `israel_utility_water_cost_estimate_forecast_ils` | Estimated cost of the portal's own month-end forecast, priced the same way. |
| `israel_utility_water_cost_estimate_previous_month_ils` | Last calendar month's final cost, priced the same way (today's tariff, not necessarily last month's). Carries a `month` label (e.g. `month="Jul"`) naming the calendar month it covers. |
| `israel_utility_water_meter_info` | Always 1; carries `meter_serial` for dashboard joins. |
| `israel_utility_water_scrape_success` / `..._last_success_timestamp_seconds` / `..._consecutive_failures` | Collector health. |

**Electricity** (label `contract_id`):

| Metric | Meaning |
| --- | --- |
| `israel_utility_electricity_meter_reading_kwh` | Cumulative meter reading. |
| `israel_utility_electricity_consumption_daily_kwh` | Consumption for the most recently published day. |
| `israel_utility_electricity_consumption_daily_covers_timestamp_seconds` | Which calendar day that is. |
| `israel_utility_electricity_consumption_monthly_kwh` | Month-to-date consumption. |
| `israel_utility_electricity_effective_rate_ils_per_kwh` | Today's blended rate, including VAT — schedule tariff mode only. |
| `israel_utility_electricity_cost_estimate_ils` | Estimated cost of the newest published day, if priced, including VAT. |
| `israel_utility_electricity_cost_estimate_monthly_ils` | Month-to-date cost, if priced, including VAT — each published day priced at its own rate and summed. |
| `israel_utility_electricity_cost_estimate_previous_month_ils` | Last calendar month's final cost, priced the same way (today's tariff, not necessarily last month's). Carries a `month` label (e.g. `month="Jul"`) naming the calendar month it covers. |
| `israel_utility_electricity_token_expires_timestamp_seconds` | When the current session token expires. |
| `israel_utility_electricity_contract_info` | Always 1; carries `contract_number`/`address` for dashboard joins. |
| `israel_utility_electricity_scrape_success` / `..._last_success_timestamp_seconds` / `..._consecutive_failures` | Collector health. |

Plus `israel_utility_exporter_build_info{version="..."}`.

## Grafana dashboard & Prometheus alerts

![Water dashboard row: meter reading, collector health, cost estimate, effective rate vs. normal, and consumption](https://raw.githubusercontent.com/Aransh/israel-utility-exporter/main/docs/dashboard-water-pricing.png)

![Electricity dashboard row: meter reading, collector health, cost estimate, effective rate, and consumption](https://raw.githubusercontent.com/Aransh/israel-utility-exporter/main/docs/dashboard-electricity.png)

- `grafana/provisioning/dashboards/files/dashboard.json` — auto-provisioned by
  `docker-compose.yml`, or import it manually into your own Grafana. Two rows
  (Water, Electricity), each with the cumulative meter trend, daily/monthly
  consumption, cost estimate, and collector health — a row just shows "No
  data" if that collector is disabled. Water's row also shows the effective
  rate as a percentage of the normal rate, turning orange once the excess
  tier kicks in.
- `prometheus/alerts.yml` — two rule groups:
  - **Health alerts** (safe to run as shipped): exporter unreachable, a
    collector going stale or failing repeatedly, electricity token nearing
    expiry.
  - **Budget alert examples** (illustrative thresholds — size to your own
    household): daily/monthly consumption over a limit.
    `WaterMonthlyConsumptionOverBudget` needs no manual sizing in tiered
    mode — it compares directly against
    `israel_utility_water_tariff_threshold_cubic_meters`.

## Behavior worth knowing

- **The daily figure isn't always today's.** Both portals publish a day's
  reading with a lag of up to ~2 days. Both collectors report the newest day
  actually published; `*_covers_timestamp_seconds` says which day that is. A
  null/unpublished reading is never reported as zero.
- **`WATER_WEEKLY_WINDOW=rolling` vs. `sunday`/`monday`**: the calendar-week
  options reset weekly (so early in a new week the total looks low because
  little has published yet); `rolling` is a trailing 7 days that never resets.
- **Electricity data is coarse.** IEC updates roughly every 1-2 days
  regardless of poll frequency — `ELECTRICITY_POLL_INTERVAL_MINUTES` below
  ~60 gains nothing.
- **Keep Prometheus's `scrape_interval` comfortably under 5 minutes**
  (its default `--query.lookback-delta`), or "current value" panels can
  intermittently show no-data even though the value hasn't changed —
  scraping `/metrics` is nearly free, so there's little cost to a fast
  interval. Want a slower one anyway? Raise `--query.lookback-delta` to
  match.
- **A rejected water password stops that collector, not the exporter** — it
  logs an error and stops polling rather than risking the portal's login
  lockout by retrying. An unrecoverable electricity token behaves the same
  way: it waits for you to re-run the login CLI instead of crash-looping.
- **Everything else (rate limits, transient errors) holds the last known
  reading** and retries on the next poll.

## Historical data backfill

The exporter only surfaces the newest published day/week/month (see above) —
anything older, or from before the exporter was first deployed, needs the
included CLI:

```bash
node dist/backfill-cli.js --service all --days 90
node dist/backfill-cli.js --service electricity --from 2026-01-01 --to 2026-03-01
node dist/backfill-cli.js --service water --days 30 --dry-run   # preview only, no write
```

Writes via the standard Prometheus **remote_write** protocol (protobuf +
Snappy), so `REMOTE_WRITE_URL` can point at Prometheus
(`--web.enable-remote-write-receiver`), Thanos, Cortex, Mimir, or any
compatible receiver. Requires `REMOTE_WRITE_URL` (except `--dry-run`) — see
the [Configuration](#configuration) table for auth/TLS options.

Things to know before running it — see [docs/backfill.md](docs/backfill.md)
for the full detail:

- **Set `REMOTE_WRITE_EXTRA_LABELS` to match your scrape config's
  `job`/`instance`**, or backfilled data lands as a separate series from
  live scrapes, splitting the graph in two.
- Cost/rate metrics are backfilled with **today's tariff config**, not
  whatever applied historically.
- Optionally reconstructs the cumulative meter reading too
  (`--estimated-readings`) — opt-in, since it can't detect a meter
  swap/reset/house move.
- Limited to whatever the portal API itself still retains — there's no way
  to go back further than that.
- **Your remote_write receiver needs to be configured to accept historical
  timestamps**, or it can silently drop them while still reporting success —
  e.g. Prometheus's own `--storage.tsdb.out-of-order-time-window` defaults to
  `0`.
- Electricity requires a token already saved by `npm run login:electricity`.
- remote_write is idempotent, so it's safe to re-run over an overlapping
  range.

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

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

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
