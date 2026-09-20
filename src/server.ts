import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
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
  // Computed once at startup, only when Basic Auth is actually configured —
  // never pay bcrypt's cost on every process start for the common case where
  // it isn't. Matches an existing user's own hash cost (falling back to 10)
  // so an unknown-username lookup and a known one cost the same regardless
  // of which cost factor this deployment's hashes were generated with.
  const dummyHash = webConfig?.basicAuthUsers ? makeDummyHash(webConfig.basicAuthUsers) : null;

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];

    // Left unauthenticated so the Dockerfile HEALTHCHECK doesn't need credentials.
    if (path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok\n');
      return;
    }

    if (webConfig?.basicAuthUsers && !isAuthorized(req.headers.authorization, webConfig.basicAuthUsers, dummyHash!)) {
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

const DEFAULT_BCRYPT_COST = 10;

function bcryptCost(hash: string): number {
  const cost = Number(/^\$2[aby]?\$(\d{2})\$/.exec(hash)?.[1]);
  return Number.isInteger(cost) ? cost : DEFAULT_BCRYPT_COST;
}

/**
 * A bcrypt hash of an unguessable password, compared against when the
 * username isn't found — so a lookup miss costs the same as a wrong password
 * instead of returning early, which would let a timing difference reveal
 * which usernames are configured. Uses an arbitrary configured user's own
 * cost factor so the two cases stay matched regardless of how this
 * deployment's real hashes were generated.
 */
function makeDummyHash(users: Record<string, string>): string {
  const cost = bcryptCost(Object.values(users)[0] ?? '');
  return bcrypt.hashSync(randomBytes(32).toString('hex'), cost);
}

function isAuthorized(header: string | undefined, users: Record<string, string>, dummyHash: string): boolean {
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
  return bcrypt.compareSync(password, hash ?? dummyHash) && hash !== undefined;
}
