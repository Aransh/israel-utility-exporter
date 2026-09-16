import { readFileSync } from 'node:fs';

import { load } from 'js-yaml';

export class WebConfigError extends Error {}

export interface WebConfig {
  tls: { cert: string; key: string } | null;
  basicAuthUsers: Record<string, string> | null;
}

interface RawWebConfig {
  tls_server_config?: { cert_file?: unknown; key_file?: unknown };
  basic_auth_users?: Record<string, unknown>;
}

/**
 * Loads and validates the optional web-config file: TLS cert/key and
 * bcrypt-hashed basic-auth users, in the same shape Prometheus's own
 * exporter-toolkit web-config.yml uses. Loaded once at startup and validated
 * eagerly — a bad config should fail the exporter at boot, not silently
 * serve unencrypted/unauthenticated traffic later. Certs are read once here;
 * restart the exporter after rotating them.
 */
export function loadWebConfig(path: string): WebConfig {
  let raw: unknown;
  try {
    raw = load(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new WebConfigError(`Could not read/parse WEB_CONFIG_FILE at ${path}: ${message(error)}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new WebConfigError(`WEB_CONFIG_FILE at ${path} must be a YAML mapping.`);
  }
  const data = raw as RawWebConfig;

  let tls: WebConfig['tls'] = null;
  if (data.tls_server_config) {
    const { cert_file, key_file } = data.tls_server_config;
    if (typeof cert_file !== 'string' || typeof key_file !== 'string') {
      throw new WebConfigError('tls_server_config.cert_file and key_file must both be set as strings.');
    }
    try {
      tls = { cert: readFileSync(cert_file, 'utf8'), key: readFileSync(key_file, 'utf8') };
    } catch (error) {
      throw new WebConfigError(`Could not read tls_server_config cert/key: ${message(error)}`);
    }
  }

  let basicAuthUsers: WebConfig['basicAuthUsers'] = null;
  if (data.basic_auth_users) {
    for (const [user, hash] of Object.entries(data.basic_auth_users)) {
      if (typeof hash !== 'string') {
        throw new WebConfigError(`basic_auth_users.${user} must be a bcrypt hash string.`);
      }
    }
    basicAuthUsers = data.basic_auth_users as Record<string, string>;
  }

  return { tls, basicAuthUsers };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
