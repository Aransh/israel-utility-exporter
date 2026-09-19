import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { effectiveWaterRate, waterCostEstimate, waterTariffThreshold } from '../cost/tariff.js';
import type { WaterConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { waterGauges } from '../metrics.js';
import { createWriteQueue, readJsonFile, writeJsonFileAtomic } from '../state/atomic-file.js';
import { dateToEpochSeconds, MONTH_ABBREVIATIONS } from '../time/day.js';
import {
  InvalidCredentialsError,
  type MeterSnapshot,
  RateLimitedError,
  RymProClient,
  UnauthorizedError,
} from './rympro-client.js';

interface PersistedWaterState {
  deviceId: string;
  token?: string;
  /**
   * Set once this collector has ever completed a successful poll. Lets the
   * backfill hint show only while there truly is no data yet, not on every
   * restart — including one that just happens to have no prior state file
   * for another reason (e.g. a wiped `token`).
   */
  hasRecordedData?: boolean;
}

const BACKFILL_HINT =
  'First run detected — no data yet, collection starts from now. To backfill historical data, see the ' +
  'README\'s "Historical data backfill" section.';

/**
 * Polls the Read Your Meter Pro portal on an interval and keeps the water
 * Prometheus gauges up to date. A poll that fails leaves the gauges holding
 * their last value (Prometheus keeps serving it under scraping) rather than
 * resetting anything to zero — a `null` reading from the portal means "not
 * published yet", never "zero water used".
 */
export class WaterCollector {
  private client: RymProClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private consecutiveFailures = 0;
  private state: PersistedWaterState | null = null;
  private readonly statePath: string;
  private readonly writeQueue = createWriteQueue();
  private readonly shutdown = new AbortController();

  constructor(
    private readonly config: WaterConfig,
    dataDir: string,
    private readonly log: Logger,
  ) {
    this.statePath = join(dataDir, 'water-state.json');
  }

  async start(): Promise<void> {
    const loaded = await readJsonFile<PersistedWaterState>(this.statePath);
    if (!loaded?.hasRecordedData) {
      this.log.info(BACKFILL_HINT);
    }
    this.state = loaded?.deviceId ? loaded : { deviceId: randomUUID() };
    this.persist();

    this.client = new RymProClient(this.config.email, this.config.password, this.state.deviceId, {
      weeklyWindow: this.config.weeklyWindow,
      onToken: (token) => {
        this.state = { ...this.state!, token };
        this.persist();
      },
      onRetry: (message) => this.log.debug(`Water: ${message}`),
      signal: this.shutdown.signal,
    });
    if (this.state.token) {
      this.client.setToken(this.state.token);
    }

    await this.poll();
  }

  stop(): void {
    this.stopped = true;
    this.shutdown.abort();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped || !this.client) {
      return;
    }

    try {
      const snapshots = await this.client.fetchAll();
      for (const snapshot of snapshots) {
        this.record(snapshot);
      }
      if (!this.state?.hasRecordedData) {
        // Only flip the in-memory flag once the write actually lands — if it
        // fails, `this.state` must stay falsy so the next successful poll
        // retries the write, instead of the flag getting stuck true in
        // memory while every restart keeps seeing an unpersisted state file.
        // Goes through the write queue (not a bare write) so it stays
        // ordered with any concurrent token write from `onToken`; flushed
        // before returning so a restart right after this poll sees it.
        const candidate = { ...this.state!, hasRecordedData: true };
        this.writeQueue.enqueue(async () => {
          try {
            await writeJsonFileAtomic(this.statePath, candidate);
            this.state = candidate;
          } catch (error) {
            this.log.warn(`Water: could not persist state: ${message(error)}`);
          }
        });
        await this.writeQueue.flush();
      }
      waterGauges.scrapeSuccess.set(1);
      waterGauges.scrapeLastSuccessTimestampSeconds.set(Date.now() / 1000);
      waterGauges.scrapeConsecutiveFailures.set(0);
      this.consecutiveFailures = 0;
      this.log.debug(`Water: fetched ${snapshots.length} meter(s)`);
    } catch (error) {
      if (this.stopped) {
        return;
      }
      this.consecutiveFailures += 1;
      waterGauges.scrapeSuccess.set(0);
      waterGauges.scrapeConsecutiveFailures.set(this.consecutiveFailures);

      if (error instanceof InvalidCredentialsError) {
        // Retrying a rejected password on a timer only risks the portal's
        // login lockout, so stop entirely rather than rescheduling.
        this.log.error(
          `Water: authentication rejected by the portal (${message(error)}). ` +
            'Polling stopped — fix WATER_EMAIL/WATER_PASSWORD and restart the exporter.',
        );
        const { token: _token, ...rest } = this.state ?? { deviceId: randomUUID() };
        this.state = rest;
        this.persist();
        return;
      }

      let kind = 'error talking to';
      if (error instanceof RateLimitedError) {
        kind = 'rate-limited by';
      } else if (error instanceof UnauthorizedError) {
        kind = 'request rejected by';
      }
      this.log.warn(`Water: ${kind} the portal: ${message(error)}. Holding last known readings.`);
    }

    this.scheduleNext();
  }

  private record(snapshot: MeterSnapshot): void {
    const labels = { meter_id: String(snapshot.meterCount), meter_serial: snapshot.serial ?? '' };
    waterGauges.meterInfo.set(labels, 1);
    waterGauges.meterReadingCubicMeters.set(labels, snapshot.total);

    if (snapshot.daily !== null) {
      waterGauges.consumptionDailyLiters.set(labels, snapshot.daily * 1000);
    }
    if (snapshot.dailyDate) {
      waterGauges.consumptionDailyCoversTimestampSeconds.set(labels, dateToEpochSeconds(snapshot.dailyDate));
    }
    if (snapshot.weekly !== null) {
      waterGauges.consumptionWeeklyLiters.set(labels, snapshot.weekly * 1000);
    }
    waterGauges.consumptionWeeklyDaysCounted.set(labels, snapshot.weeklyDaysCounted);
    waterGauges.consumptionWeeklyDaysElapsed.set(labels, snapshot.weeklyDaysElapsed);

    if (snapshot.monthly !== null) {
      waterGauges.consumptionMonthlyLiters.set(labels, snapshot.monthly * 1000);
      if (this.config.tariffMode === 'tiered' && this.config.tariffTiers) {
        waterGauges.tariffThresholdCubicMeters.set(labels, waterTariffThreshold(this.config.tariffTiers));
        waterGauges.effectiveRateIlsPerCubicMeter.set(labels, effectiveWaterRate(this.config.tariffTiers, snapshot.monthly));
        waterGauges.tariffNormalRateIlsPerCubicMeter.set(labels, this.config.tariffTiers.normalRatePerCubicMeter);
      }
      const cost = this.costEstimate(snapshot.monthly);
      if (cost !== null) {
        waterGauges.costEstimateIls.set(labels, cost);
      }
    }
    if (snapshot.forecast !== null) {
      waterGauges.consumptionForecastLiters.set(labels, snapshot.forecast * 1000);
      const forecastCost = this.costEstimate(snapshot.forecast);
      if (forecastCost !== null) {
        waterGauges.costEstimateForecastIls.set(labels, forecastCost);
      }
    }
    const previousMonthCost = snapshot.previousMonth !== null ? this.costEstimate(snapshot.previousMonth) : null;
    // `month` is a label value that changes over time, unlike every other
    // label on this gauge — without pruning every other possible value,
    // each calendar month's entry would stick around forever (a Gauge
    // never forgets a label combination it was once `.set()` with), so
    // scrapes a year from now would show up to 12 stale "previous month"
    // series at once instead of just the current one. Pruned unconditionally
    // (not only when there's a new cost to set) so a month with no data of
    // its own doesn't leave an *older* month's entry stuck around either.
    for (const month of MONTH_ABBREVIATIONS) {
      if (month !== snapshot.previousMonthLabel || previousMonthCost === null) {
        waterGauges.costEstimatePreviousMonthIls.remove({ ...labels, month });
      }
    }
    if (previousMonthCost !== null && snapshot.previousMonthLabel !== null) {
      waterGauges.costEstimatePreviousMonthIls.set({ ...labels, month: snapshot.previousMonthLabel }, previousMonthCost);
    }
  }

  /** ILS cost of `consumptionCubicMeters` under the configured tariff, or null if no pricing is configured. */
  private costEstimate(consumptionCubicMeters: number): number | null {
    return waterCostEstimate(this.config, consumptionCubicMeters);
  }

  private scheduleNext(): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.poll().catch((error: unknown) => {
        this.log.error(`Water: poll failed unexpectedly: ${message(error)}`);
      });
    }, this.config.pollIntervalMs);
    this.timer.unref?.();
  }

  private persist(): void {
    if (!this.state) {
      return;
    }
    const snapshot = this.state;
    this.writeQueue.enqueue(async () => {
      try {
        await writeJsonFileAtomic(this.statePath, snapshot);
      } catch (error) {
        this.log.warn(`Water: could not persist state: ${message(error)}`);
      }
    });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
