import { createServer, type Server } from 'node:http';

import type { Logger } from './logger.js';
import { registry } from './metrics.js';

export function startServer(port: number, log: Logger): Server {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    if (path === '/metrics') {
      registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'Content-Type': registry.contentType });
          res.end(body);
        })
        .catch((error: unknown) => {
          log.error(`Failed to render metrics: ${error instanceof Error ? error.message : String(error)}`);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('internal error rendering metrics\n');
        });
      return;
    }

    if (path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok\n');
      return;
    }

    if (path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('israel-utility-exporter\n\nSee /metrics for Prometheus metrics, /healthz for a liveness check.\n');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
  });

  server.listen(port, () => {
    log.info(`Listening on :${port} (/metrics, /healthz)`);
  });

  return server;
}
