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
  costEstimateIls: new Gauge({
    name: 'israel_utility_water_cost_estimate_ils',
    help: 'Estimated cost of this month-to-date consumption, using WATER_PRICE_PER_CUBIC_METER. Only present when that is set.',
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
    help: "Today's duration-weighted blended tariff rate, ILS/kWh. Only present in schedule tariff mode — see README for what \"blended\" means.",
    labelNames: ELECTRICITY_LABELS,
    registers: [registry],
  }),
  costEstimateIls: new Gauge({
    name: 'israel_utility_electricity_cost_estimate_ils',
    help: 'Estimated cost of the most recently published day, ILS. Only present when a price or tariff schedule is configured.',
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
