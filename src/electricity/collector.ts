import { join } from 'node:path';

import { blendedRateForDay, loadTariffSchedule, type TariffSchedule } from '../cost/tariff.js';
import type { ElectricityConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { electricityGauges } from '../metrics.js';
import { readJsonFile, writeJsonFileAtomic } from '../state/atomic-file.js';
import { dateToEpochSeconds, parseYmdNoon } from '../time/day.js';
import { type ElectricitySnapshot, IECError, IECLoginError, IecClient } from './iec-client.js';

const TOKEN_NOT_FOUND_ADVICE =
  'No IEC token found. Run the one-time login: ' +
  '`docker run --rm -it -v <data-volume>:/data <image> node dist/electricity/login-cli.js --id <israeli-id>`.';

const BACKFILL_HINT =
  'First run detected — no data yet, collection starts from now. To backfill historical data, see the ' +
  'README\'s "Historical data backfill" section.';

interface PersistedElectricityState {
  /** Set once this collector has ever completed a successful poll — shows the backfill hint only while there truly is no data yet. */
  hasRecordedData?: boolean;
}

/**
 * Polls the IEC API on an interval and keeps the electricity Prometheus
 * gauges up to date. Unlike the water collector, there is no way to recover
 * from an expired session by logging in again here — IEC login needs an
 * interactive OTP — so an expired refresh token is reported clearly rather
 * than retried.
 */
export class ElectricityCollector {
  private client: IecClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private consecutiveFailures = 0;
  private tariffSchedule: TariffSchedule | null = null;
  private state: PersistedElectricityState | null = null;
  private readonly statePath: string;

  constructor(
    private readonly config: ElectricityConfig,
    dataDir: string,
    private readonly log: Logger,
  ) {
    this.statePath = join(dataDir, 'electricity-state.json');
    if (config.tariffMode === 'schedule' && config.tariffScheduleFile) {
      // Loaded once at startup and validated eagerly: a bad schedule file
      // should fail the exporter at boot, not silently stop pricing later.
      this.tariffSchedule = loadTariffSchedule(config.tariffScheduleFile);
    }
  }

  async start(): Promise<void> {
    this.state = await readJsonFile<PersistedElectricityState>(this.statePath);
    if (!this.state?.hasRecordedData) {
      this.log.info(BACKFILL_HINT);
    }
    await this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped) {
      return;
    }

    try {
      const client = await this.ensureClient();
      const snapshot = await client.fetchSnapshot();
      this.record(snapshot);
      // The token may have just been refreshed; persist it so a restart
      // doesn't throw away a still-valid refresh token.
      await client.saveTokenToFile(this.config.tokenFile).catch((error: unknown) => {
        this.log.warn(`Electricity: could not persist refreshed token: ${message(error)}`);
      });
      if (!this.state?.hasRecordedData) {
        this.state = { hasRecordedData: true };
        await writeJsonFileAtomic(this.statePath, this.state).catch((error: unknown) => {
          this.log.warn(`Electricity: could not persist collector state: ${message(error)}`);
        });
      }

      electricityGauges.scrapeSuccess.set(1);
      electricityGauges.scrapeLastSuccessTimestampSeconds.set(Date.now() / 1000);
      electricityGauges.scrapeConsecutiveFailures.set(0);
      this.consecutiveFailures = 0;
      this.log.debug(`Electricity: fetched contract ${snapshot.contractId}`);
    } catch (error) {
      if (this.stopped) {
        return;
      }
      this.consecutiveFailures += 1;
      electricityGauges.scrapeSuccess.set(0);
      electricityGauges.scrapeConsecutiveFailures.set(this.consecutiveFailures);

      if (error instanceof IECLoginError) {
        this.client = null;
        this.log.error(`Electricity: ${message(error)}. ${TOKEN_NOT_FOUND_ADVICE}`);
      } else if (error instanceof IECError) {
        this.log.warn(`Electricity: request rejected by IEC: ${message(error)}. Holding last known readings.`);
      } else {
        this.log.warn(`Electricity: ${message(error)}. Holding last known readings.`);
      }
    }

    this.scheduleNext();
  }

  private async ensureClient(): Promise<IecClient> {
    if (this.client) {
      return this.client;
    }
    const client = new IecClient(this.config.israeliId, { log: (msg) => this.log.debug(`Electricity: ${msg}`) });
    try {
      await client.loadTokenFromFile(this.config.tokenFile);
    } catch (error) {
      throw new IECLoginError(-1, `Could not load token from ${this.config.tokenFile}: ${message(error)}`);
    }
    this.client = client;
    return client;
  }

  private record(snapshot: ElectricitySnapshot): void {
    const labels = { contract_id: snapshot.contractId };
    electricityGauges.contractInfo.set(
      { contract_id: snapshot.contractId, contract_number: snapshot.contractNumber ?? '', address: snapshot.address ?? '' },
      1,
    );

    if (snapshot.meterReadingKwh !== null) {
      electricityGauges.meterReadingKwh.set(labels, snapshot.meterReadingKwh);
    }
    if (snapshot.tokenExpiresAt !== null) {
      electricityGauges.tokenExpiresTimestampSeconds.set(labels, snapshot.tokenExpiresAt);
    }
    if (snapshot.monthly !== null) {
      electricityGauges.consumptionMonthlyKwh.set(labels, snapshot.monthly);
    }

    if (snapshot.daily === null || !snapshot.dailyDate) {
      return;
    }
    electricityGauges.consumptionDailyKwh.set(labels, snapshot.daily);
    electricityGauges.consumptionDailyCoversTimestampSeconds.set(labels, dateToEpochSeconds(snapshot.dailyDate));

    const rate = this.effectiveRate(snapshot.dailyDate);
    if (rate !== null) {
      if (this.tariffSchedule) {
        electricityGauges.effectiveRateIlsPerKwh.set(labels, rate);
      }
      electricityGauges.costEstimateIls.set(labels, snapshot.daily * rate);
    }
  }

  /** ILS/kWh to price the given day at, or null if no pricing is configured. */
  private effectiveRate(dailyDateYmd: string): number | null {
    if (this.tariffSchedule) {
      return blendedRateForDay(this.tariffSchedule, parseYmdNoon(dailyDateYmd));
    }
    return this.config.pricePerKwh;
  }

  private scheduleNext(): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.poll().catch((error: unknown) => {
        this.log.error(`Electricity: poll failed unexpectedly: ${message(error)}`);
      });
    }, this.config.pollIntervalMs);
    this.timer.unref?.();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
