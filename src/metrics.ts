import { Gauge, Registry } from '@prometheus-io/client';
import { readFileSync } from 'node:fs';

export const registry = new Registry();

new Gauge({
  name: 'israel_utility_exporter_build_info',
  help: 'Exporter build metadata. Always 1.',
  labelNames: ['version'],
  registers: [registry],
}).set({ version: readVersion() }, 1);

function readVersion(): string {
  try {
    const url = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const WATER_LABELS = ['meter_id', 'meter_serial'] as const;

export const waterGauges = {
  meterReadingCubicMeters: new Gauge({
    name: 'israel_utility_water_meter_reading_cubic_meters',
    help: 'Cumulative water meter reading, m3.',
    labelNames: WATER_LABELS,
    registers: [registry],
  }),
  consumptionDailyLiters: new Gauge({
    name: 'israel_utility_water_consumption_daily_liters',
    help: "Consumption for the most recently published day, liters. Not always today's — see the *_covers_timestamp_seconds metric.",
    labelNames: WATER_LABELS,
    registers: [registry],
  }),
  consumptionDailyCoversTimestampSeconds: new Gauge({
    name: 'israel_utility_water_consumption_daily_covers_timestamp_seconds',
    help: 'Midnight (local) of the calendar day the daily consumption figure covers.',
    labelNames: WATER_LABELS,
    registers: [registry],
  }),
  consumptionWeeklyLiters: new Gauge({
    name: 'israel_utility_water_consumption_weekly_liters',
    help: 'Consumption over the configured weekly window, liters.',
    labelNames: WATER_LABELS,
    registers: [registry],
  }),
  consumptionWeeklyDaysCounted: new Gauge({
    name: 'israel_utility_water_consumption_weekly_days_counted',
    help: 'How many days of the weekly window have a published reading.',
    labelNames: WATER_LABELS,
    registers: [registry],
  }),
  consumptionWeeklyDaysElapsed: new Gauge({
    name: 'israel_utility_water_consumption_weekly_days_elapsed',
    help: 'How many days of the weekly window have begun.',
    labelNames: WATER_LABELS,
    registers: [registry],
  }),
  consumptionMonthlyLiters: new Gauge({
    name: 'israel_utility_water_consumption_monthly_liters',
    help: 'Consumption so far this calendar month, liters.',
    labelNames: WATER_LABELS,
    registers: [registry],
  }),
  consumptionForecastLiters: new Gauge({
    name: 'israel_utility_water_consumption_forecast_liters',
    help: "The portal's own month-end consumption forecast, liters.",
    labelNames: WATER_LABELS,
    registers: [registry],
  }),
  tariffThresholdCubicMeters: new Gauge({
    name: 'israel_utility_water_tariff_threshold_cubic_meters',
    help: "This month's subsidized-rate threshold (max(WATER_TARIFF_HOUSEHOLD_SIZE, 2) x WATER_TARIFF_ALLOWANCE_PER_PERSON_CUBIC_METERS), m3. Only present in tiered tariff mode.",
    labelNames: WATER_LABELS,
    registers: [registry],
  }),
  effectiveRateIlsPerCubicMeter: new Gauge({
    name: 'israel_utility_water_effective_rate_ils_per_cubic_meter',
    help: "This month-to-date consumption's blended ILS/m3 rate, including VAT (see VAT_PERCENT). Only present in tiered tariff mode — see README for what \"tiered\" means.",
    labelNames: WATER_LABELS,
    registers: [registry],
  }),
  tariffNormalRateIlsPerCubicMeter: new Gauge({
    name: 'israel_utility_water_tariff_normal_rate_ils_per_cubic_meter',
    help: 'The configured below-allowance ILS/m3 rate (WATER_PRICE_PER_CUBIC_METER), including VAT (see VAT_PERCENT), exposed so dashboards can flag when the blended effective rate has crept above it. Only present in tiered tariff mode.',
    labelNames: WATER_LABELS,
    registers: [registry],
  }),
  costEstimateIls: new Gauge({
    name: 'israel_utility_water_cost_estimate_ils',
    help: 'Estimated cost of this month-to-date consumption, including VAT (see VAT_PERCENT). Only present when WATER_PRICE_PER_CUBIC_METER is set (flat mode) or WATER_TARIFF_MODE=tiered is fully configured.',
    labelNames: WATER_LABELS,
    registers: [registry],
  }),
  costEstimateForecastIls: new Gauge({
    name: 'israel_utility_water_cost_estimate_forecast_ils',
    help: "Estimated cost of the portal's own month-end consumption forecast, priced the same way as israel_utility_water_cost_estimate_ils. Only present when priced.",
    labelNames: WATER_LABELS,
    registers: [registry],
  }),
  costEstimatePreviousMonthIls: new Gauge({
    name: 'israel_utility_water_cost_estimate_previous_month_ils',
    help: "Last calendar month's final cost, priced the same way as israel_utility_water_cost_estimate_ils (i.e. with today's tariff config, not necessarily the one that applied last month). Only present when priced.",
    labelNames: WATER_LABELS,
    registers: [registry],
  }),
  meterInfo: new Gauge({
    name: 'israel_utility_water_meter_info',
    help: 'Always 1. Carries the meter serial as a label for dashboard joins.',
    labelNames: WATER_LABELS,
    registers: [registry],
  }),
  scrapeSuccess: new Gauge({
    name: 'israel_utility_water_scrape_success',
    help: '1 if the most recent poll of the water portal succeeded, else 0.',
    registers: [registry],
  }),
  scrapeLastSuccessTimestampSeconds: new Gauge({
    name: 'israel_utility_water_scrape_last_success_timestamp_seconds',
    help: 'Unix time of the last successful poll of the water portal.',
    registers: [registry],
  }),
  scrapeConsecutiveFailures: new Gauge({
    name: 'israel_utility_water_scrape_consecutive_failures',
    help: 'Consecutive failed polls of the water portal.',
    registers: [registry],
  }),
};

const ELECTRICITY_LABELS = ['contract_id'] as const;

export const electricityGauges = {
  meterReadingKwh: new Gauge({
    name: 'israel_utility_electricity_meter_reading_kwh',
    help: 'Cumulative electricity meter reading, kWh.',
    labelNames: ELECTRICITY_LABELS,
    registers: [registry],
  }),
  consumptionDailyKwh: new Gauge({
    name: 'israel_utility_electricity_consumption_daily_kwh',
    help: 'Consumption for the most recently published day, kWh.',
    labelNames: ELECTRICITY_LABELS,
    registers: [registry],
  }),
  consumptionDailyCoversTimestampSeconds: new Gauge({
    name: 'israel_utility_electricity_consumption_daily_covers_timestamp_seconds',
    help: 'Midnight (local) of the calendar day the daily consumption figure covers.',
    labelNames: ELECTRICITY_LABELS,
    registers: [registry],
  }),
  consumptionMonthlyKwh: new Gauge({
    name: 'israel_utility_electricity_consumption_monthly_kwh',
    help: 'Consumption so far this calendar month, kWh.',
    labelNames: ELECTRICITY_LABELS,
    registers: [registry],
  }),
  effectiveRateIlsPerKwh: new Gauge({
    name: 'israel_utility_electricity_effective_rate_ils_per_kwh',
    help: "Today's duration-weighted blended tariff rate, ILS/kWh, including VAT (see VAT_PERCENT). Only present in schedule tariff mode — see README for what \"blended\" means.",
    labelNames: ELECTRICITY_LABELS,
    registers: [registry],
  }),
  costEstimateIls: new Gauge({
    name: 'israel_utility_electricity_cost_estimate_ils',
    help: 'Estimated cost of the most recently published day, ILS, including VAT (see VAT_PERCENT). Only present when a price or tariff schedule is configured.',
    labelNames: ELECTRICITY_LABELS,
    registers: [registry],
  }),
  costEstimateMonthlyIls: new Gauge({
    name: 'israel_utility_electricity_cost_estimate_monthly_ils',
    help: 'Estimated cost of this month-to-date consumption, ILS, each published day priced at its own rate and summed, including VAT (see VAT_PERCENT). Only present when a price or tariff schedule is configured.',
    labelNames: ELECTRICITY_LABELS,
    registers: [registry],
  }),
  costEstimatePreviousMonthIls: new Gauge({
    name: 'israel_utility_electricity_cost_estimate_previous_month_ils',
    help: "Last calendar month's final cost, priced the same way as israel_utility_electricity_cost_estimate_monthly_ils (i.e. with today's tariff config, not necessarily the one that applied last month). Only present when a price or tariff schedule is configured.",
    labelNames: ELECTRICITY_LABELS,
    registers: [registry],
  }),
  tokenExpiresTimestampSeconds: new Gauge({
    name: 'israel_utility_electricity_token_expires_timestamp_seconds',
    help: 'Unix time the current IEC session token expires. Falls back to re-login being needed once the refresh token itself lapses.',
    labelNames: ELECTRICITY_LABELS,
    registers: [registry],
  }),
  contractInfo: new Gauge({
    name: 'israel_utility_electricity_contract_info',
    help: 'Always 1. Carries the contract number and address as labels for dashboard joins.',
    labelNames: ['contract_id', 'contract_number', 'address'],
    registers: [registry],
  }),
  scrapeSuccess: new Gauge({
    name: 'israel_utility_electricity_scrape_success',
    help: '1 if the most recent poll of the IEC API succeeded, else 0.',
    registers: [registry],
  }),
  scrapeLastSuccessTimestampSeconds: new Gauge({
    name: 'israel_utility_electricity_scrape_last_success_timestamp_seconds',
    help: 'Unix time of the last successful poll of the IEC API.',
    registers: [registry],
  }),
  scrapeConsecutiveFailures: new Gauge({
    name: 'israel_utility_electricity_scrape_consecutive_failures',
    help: 'Consecutive failed polls of the IEC API.',
    registers: [registry],
  }),
};
