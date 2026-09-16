#!/usr/bin/env node
/**
 * Starts the exporter's HTTP server standalone — no water/electricity
 * collector, so no credentials needed — and prints its /metrics output to
 * stdout, for piping into `promtool check metrics` in CI. That's an
 * objective, external check that the exposition format stays valid as
 * metrics are added or changed, run against dist/, so build first:
 *
 *   npm run build
 *   node scripts/check-metrics-format.mjs | promtool check metrics
 */
import { createLogger } from '../dist/logger.js';
import { startServer } from '../dist/server.js';

const PORT = 19877;
const log = createLogger('error');
const server = startServer(PORT, log, null);

async function waitForMetrics(url, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Server did not become ready in time: ${url}`);
}

const res = await waitForMetrics(`http://localhost:${PORT}/metrics`);
if (!res.ok) {
  console.error(`GET /metrics returned ${res.status}`);
  process.exitCode = 1;
} else {
  process.stdout.write(await res.text());
}

server.close();
