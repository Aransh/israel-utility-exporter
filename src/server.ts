import bcrypt from 'bcryptjs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';

import type { Logger } from './logger.js';
import { registry } from './metrics.js';
import type { WebConfig } from './web-config.js';

export function startServer(port: number, log: Logger, webConfig: WebConfig | null = null): HttpServer | HttpsServer {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];

    // Left unauthenticated so the Dockerfile HEALTHCHECK doesn't need credentials.
    if (path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok\n');
      return;
    }

    if (webConfig?.basicAuthUsers && !isAuthorized(req.headers.authorization, webConfig.basicAuthUsers)) {
      res.writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Basic realm="israel-utility-exporter"' });
      res.end('unauthorized\n');
      return;
    }

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

    if (path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('israel-utility-exporter\n\nSee /metrics for Prometheus metrics, /healthz for a liveness check.\n');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
  };

  const server = webConfig?.tls
    ? createHttpsServer({ cert: webConfig.tls.cert, key: webConfig.tls.key }, handler)
    : createHttpServer(handler);

  server.listen(port, () => {
    const features = [webConfig?.tls && 'tls', webConfig?.basicAuthUsers && 'basic-auth'].filter(Boolean).join(', ');
    log.info(`Listening on :${port} (/metrics, /healthz)${features ? ` [${features}]` : ''}`);
  });

  return server;
}

function isAuthorized(header: string | undefined, users: Record<string, string>): boolean {
  if (header?.slice(0, 6).toLowerCase() !== 'basic ') {
    return false;
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep === -1) {
    return false;
  }
  const user = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);
  const hash = users[user];
  return hash !== undefined && bcrypt.compareSync(password, hash);
}
