import type { LogLevel } from './config.js';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Plain stdout/stderr logger — a Docker container's logs are its logging UI. */
export function createLogger(level: LogLevel): Logger {
  const enabled = (l: LogLevel) => LEVEL_ORDER[l] >= LEVEL_ORDER[level];
  const line = (l: Uppercase<LogLevel>, message: string) => `[${new Date().toISOString()}] ${l} ${message}`;
  return {
    debug: (message) => enabled('debug') && console.log(line('DEBUG', message)),
    info: (message) => enabled('info') && console.log(line('INFO', message)),
    warn: (message) => enabled('warn') && console.warn(line('WARN', message)),
    error: (message) => enabled('error') && console.error(line('ERROR', message)),
  };
}
