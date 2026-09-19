# Cost estimation

Full detail behind the [Cost estimation](../README.md#cost-estimation) section
of the README: VAT handling, the time-of-use schedule's accuracy limits, and a
worked example for volume-tiered water pricing.

## VAT

**Enter the pre-VAT rate — VAT is added automatically.** Every price you
configure (`WATER_PRICE_PER_CUBIC_METER`,
`WATER_TARIFF_EXCESS_PRICE_PER_CUBIC_METER`, `ELECTRICITY_PRICE_PER_KWH`, a
schedule file's `baseRatePerKwh`) is treated as the **pre-VAT** rate;
`VAT_PERCENT` (18% by default — Israel's standard rate) grosses it up before
it reaches any cost or rate metric, for both utilities alike, and for both the
live collectors and the backfill CLI. This is straightforward for
electricity — a real IEC-supplier bill's per-kWh line items are explicitly
labeled "לא כולל מע"מ" (not including VAT), so the pre-VAT number is exactly
what's on the bill. **Water is the opposite convention**: the Water
Authority's own published tariffs are already VAT-inclusive (see the worked
example below for how to back out the pre-VAT number before configuring it).
Set `VAT_PERCENT=0` if you'd rather enter an already VAT-inclusive rate
directly, or you're VAT-exempt.

All of `israel_utility_water_cost_estimate_ils`,
`israel_utility_water_effective_rate_ils_per_cubic_meter`,
`israel_utility_water_tariff_normal_rate_ils_per_cubic_meter`,
`israel_utility_electricity_cost_estimate_ils`,
`israel_utility_electricity_cost_estimate_monthly_ils`, and
`israel_utility_electricity_effective_rate_ils_per_kwh` are VAT-inclusive as a
result — as is anything the backfill CLI writes for them.

## Time-of-use schedule (electricity)

`ELECTRICITY_TARIFF_MODE=schedule` models Israeli "taoz" plans like "70% off
17:00-23:00" offered by several private electricity suppliers. See
`tariff-schedule.example.json`:

```json
{
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
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)). So instead of
pretending to know when in the day you used electricity, the exporter
computes a **duration-weighted blended rate for that calendar day** — e.g. 6
discounted hours + 18 base hours, averaged — and multiplies the day's total
kWh by that single number. This assumes consumption is roughly even across
the day. It is a genuinely useful estimate for comparing plans or tracking a
trend, but it is **not a bill reconstruction** — expect it to diverge from
your actual invoice, more so the more your usage is concentrated in or out of
the discount window. `israel_utility_electricity_effective_rate_ils_per_kwh`
exposes the blended rate itself, so the assumption is visible rather than
hidden inside a cost figure.

## Volume-tiered pricing (water)

Water has no time-of-use concept in Israel — tariffs are volume-tiered
instead, a subsidized allowance per person registered on the account, then a
higher rate beyond it (see e.g. a local water corporation's published
tariffs, like [Yuval Lim's](https://www.yuvallim.co.il/תעריפי-מים-וביוב/)).
Configure:

- `WATER_PRICE_PER_CUBIC_METER` — the rate below the allowance (the same
  variable flat mode uses).
- `WATER_TARIFF_EXCESS_PRICE_PER_CUBIC_METER` — the rate above it.
- `WATER_TARIFF_HOUSEHOLD_SIZE` — people registered on the account.
- `WATER_TARIFF_ALLOWANCE_PER_PERSON_CUBIC_METERS` — m3/person/month before
  the excess rate kicks in.

This month's threshold is `max(WATER_TARIFF_HOUSEHOLD_SIZE, 2) x
WATER_TARIFF_ALLOWANCE_PER_PERSON_CUBIC_METERS` — Israeli water tariffs
guarantee every housing unit at least a 2-person allowance regardless of how
few people are registered there, so a solo resident isn't shortchanged (this
floor is fixed by law, not a separate variable). Consumption up to the
threshold is priced at the normal rate, the rest at the excess rate.
`israel_utility_water_tariff_threshold_cubic_meters` and
`israel_utility_water_effective_rate_ils_per_cubic_meter` expose the
threshold and the resulting blended ILS/m3 rate, so — as with electricity's
schedule mode — neither is hidden inside the cost figure.
`israel_utility_water_tariff_normal_rate_ils_per_cubic_meter` also exposes
the configured below-allowance rate itself, so a dashboard can flag once the
blended rate has crept above it, without hardcoding your rate into the
dashboard.

**Get the actual numbers from your own water corporation's published tariff
and account details** — they change periodically and this exporter doesn't
fetch them. Watch the units:
`WATER_TARIFF_ALLOWANCE_PER_PERSON_CUBIC_METERS` is m3/person **per month**
(matching `israel_utility_water_consumption_monthly_liters`), but published
tariffs often quote it per **two months** instead — e.g. Yuval Lim's page
says "עד 7 מ"ק לנפש **לחודשיים**" (up to 7 m3/person per two months) right
next to "3.5 מ״ק **לחודש**" (3.5 m3/month) for the same allowance; use the
monthly figure (`3.5`), not the bimonthly one (`7`), or you'll double the
real threshold.

One more unit to watch: unlike electricity, Israel's Water Authority
publishes its water tariffs **already including VAT** (its own rate sheet
labels them "כוללים מע"מ") — the opposite convention from an electricity
bill's per-kWh line items. Since `VAT_PERCENT` grosses up every price here
the same way regardless of utility (see above), paste the **pre-VAT** number,
not the published one, or VAT ends up applied twice. A worked example: Yuval
Lim's page lists `8.51`/`15.62` ₪/m3 as its published, VAT-inclusive rates;
divide each by `1 + VAT_PERCENT/100` (1.18 at the default 18%) to get the
pre-VAT numbers to configure: `WATER_PRICE_PER_CUBIC_METER=7.21`,
`WATER_TARIFF_EXCESS_PRICE_PER_CUBIC_METER=13.24`,
`WATER_TARIFF_ALLOWANCE_PER_PERSON_CUBIC_METERS=3.5`. Also note this is still
a calendar-month approximation of a tariff actually billed over a 2-month
cycle — usage concentrated near a bimonthly cycle boundary (e.g. low one
calendar month, high the next) can price slightly differently than the real
bill, which averages allowance use across the full 2-month period rather
than resetting it every calendar month.
