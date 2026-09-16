import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';

import { compress } from 'snappyjs';

import { encodeWriteRequest, type RwTimeSeries } from './protobuf.js';

export interface RemoteWriteTlsOptions {
  /** Custom CA bundle (PEM), for a receiver with a private/self-signed certificate. */
  ca?: string;
  /** Client certificate (PEM), for mTLS. Must be paired with `key`. */
  cert?: string;
  /** Client private key (PEM), for mTLS. Must be paired with `cert`. */
  key?: string;
  /** Disables certificate verification entirely. Testing/self-signed use only — never for production. */
  insecureSkipVerify?: boolean;
}

export interface RemoteWriteSettings {
  url: string;
  username?: string;
  password?: string;
  bearerToken?: string;
  timeoutMs: number;
  tls?: RemoteWriteTlsOptions;
  /** Delay before each retry of a 429/5xx response, in order. Defaults to `[1s, 4s, 15s]`; overridable for tests. */
  retryBackoffMs?: number[];
}

export class RemoteWriteError extends Error {}

const DEFAULT_RETRY_BACKOFF_MS = [1_000, 4_000, 15_000];

/**
 * Snappy-compresses and POSTs a `WriteRequest` to a standard Prometheus
 * remote_write endpoint. Retries 429/5xx a bounded number of times with
 * jittered backoff; any other non-2xx (e.g. 400/401) fails immediately since
 * retrying a malformed request or bad auth won't help.
 */
export async function remoteWrite(settings: RemoteWriteSettings, series: RwTimeSeries[]): Promise<void> {
  if (series.length === 0) {
    return;
  }
  const body = compress(encodeWriteRequest(series));
  const backoff = settings.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;

  for (let attempt = 0; ; attempt += 1) {
    const response = await post(settings, body);
    if (response.status >= 200 && response.status < 300) {
      return;
    }
    const retryable = response.status === 429 || response.status >= 500;
    const nextDelay = backoff[attempt];
    if (!retryable || nextDelay === undefined) {
      throw new RemoteWriteError(`remote_write POST failed: HTTP ${response.status} ${response.body.slice(0, 300)}`);
    }
    await sleep(nextDelay * (0.75 + Math.random() * 0.5));
  }
}

function post(settings: RemoteWriteSettings, body: Buffer): Promise<{ status: number; body: string }> {
  const url = new URL(settings.url);
  const isHttps = url.protocol === 'https:';

  const headers: Record<string, string> = {
    'Content-Encoding': 'snappy',
    'Content-Type': 'application/x-protobuf',
    'X-Prometheus-Remote-Write-Version': '0.1.0',
    'Content-Length': String(body.length),
  };
  if (settings.bearerToken) {
    headers.authorization = `Bearer ${settings.bearerToken}`;
  } else if (settings.username && settings.password) {
    headers.authorization = `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString('base64')}`;
  }

  const options: RequestOptions = {
    method: 'POST',
    headers,
    timeout: settings.timeoutMs,
    ca: settings.tls?.ca,
    cert: settings.tls?.cert,
    key: settings.tls?.key,
    rejectUnauthorized: !settings.tls?.insecureSkipVerify,
  };

  return new Promise((resolve, reject) => {
    const req = (isHttps ? httpsRequest : httpRequest)(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('timeout', () => req.destroy(new RemoteWriteError(`remote_write POST to ${url.hostname} timed out after ${settings.timeoutMs}ms`)));
    req.on('error', (error) => reject(error instanceof Error ? error : new RemoteWriteError(String(error))));
    req.end(body);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
