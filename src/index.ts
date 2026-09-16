import { ConfigError, loadConfig } from './config.js';
import { ElectricityCollector } from './electricity/collector.js';
import { createLogger } from './logger.js';
import { startServer } from './server.js';
import { resolveDataDir } from './state/paths.js';
import { WaterCollector } from './water/collector.js';
import { loadWebConfig, WebConfigError } from './web-config.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Configuration error: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const log = createLogger(config.logLevel);
  await resolveDataDir(config.dataDir);

  let webConfig = null;
  if (config.webConfigFile) {
    try {
      webConfig = loadWebConfig(config.webConfigFile);
    } catch (error) {
      if (error instanceof WebConfigError) {
        console.error(`Configuration error: ${error.message}`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  }

  // Started before the collectors' first poll (which can take a while — a
  // slow or rate-limited portal shouldn't delay /healthz and /metrics coming up).
  const server = startServer(config.port, log, webConfig);

  const collectors: Array<{ stop: () => void }> = [];

  if (config.water) {
    log.info(
      `Water collector enabled (poll every ${Math.round(config.water.pollIntervalMs / 60_000)}m, weekly window: ${config.water.weeklyWindow}).`,
    );
    const water = new WaterCollector(config.water, config.dataDir, log);
    collectors.push(water);
    water.start().catch((error: unknown) => {
      log.error(`Water: failed to start: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  if (config.electricity) {
    log.info(`Electricity collector enabled (poll every ${Math.round(config.electricity.pollIntervalMs / 60_000)}m).`);
    const electricity = new ElectricityCollector(config.electricity, log);
    collectors.push(electricity);
    electricity.start().catch((error: unknown) => {
      log.error(`Electricity: failed to start: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  const shutdown = (signal: string) => {
    log.info(`Received ${signal}, shutting down.`);
    for (const collector of collectors) {
      collector.stop();
    }
    server.close(() => process.exit(0));
    // Force-exit if close hangs (e.g. a keep-alive connection lingering).
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(`Fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
