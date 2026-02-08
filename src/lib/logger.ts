/**
 * Klubz - Structured Logging Service
 *
 * Production-grade structured logging for Cloudflare Workers.
 * Integrates with Cloudflare Logpush, Tail Workers, or console.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  requestId?: string;
  userId?: number;
  action?: string;
  duration?: number;
  metadata?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0, info: 1, warn: 2, error: 3, fatal: 4,
};

class Logger {
  private minLevel: LogLevel;

  constructor(minLevel: LogLevel = 'info') {
    this.minLevel = minLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.minLevel];
  }

  private emit(entry: LogEntry) {
    if (!this.shouldLog(entry.level)) return;

    const output = JSON.stringify({
      ...entry,
      service: 'klubz-api',
      version: '3.1.0',
    });

    switch (entry.level) {
      case 'error':
      case 'fatal':
        console.error(output);
        break;
      case 'warn':
        console.warn(output);
        break;
      default:
        console.log(output);
    }
  }

  debug(message: string, meta?: Record<string, unknown>) {
    this.emit({ level: 'debug', message, timestamp: new Date().toISOString(), metadata: meta });
  }

  info(message: string, meta?: Record<string, unknown>) {
    this.emit({ level: 'info', message, timestamp: new Date().toISOString(), metadata: meta });
  }

  warn(message: string, meta?: Record<string, unknown>) {
    this.emit({ level: 'warn', message, timestamp: new Date().toISOString(), metadata: meta });
  }

  error(message: string, error?: Error, meta?: Record<string, unknown>) {
    this.emit({
      level: 'error',
      message,
      timestamp: new Date().toISOString(),
      metadata: meta,
      error: error ? { name: error.name, message: error.message, stack: error.stack?.slice(0, 500) } : undefined,
    });
  }

  fatal(message: string, error?: Error, meta?: Record<string, unknown>) {
    this.emit({
      level: 'fatal',
      message,
      timestamp: new Date().toISOString(),
      metadata: meta,
      error: error ? { name: error.name, message: error.message, stack: error.stack?.slice(0, 500) } : undefined,
    });
  }

  /** Log an audit event (always info level, structured for compliance). */
  audit(action: string, userId: number | undefined, meta?: Record<string, unknown>) {
    this.emit({
      level: 'info',
      message: `AUDIT: ${action}`,
      timestamp: new Date().toISOString(),
      action,
      userId,
      metadata: { ...meta, _audit: true },
    });
  }

  /** Log a request/response pair. */
  request(method: string, path: string, status: number, duration: number, requestId: string, meta?: Record<string, unknown>) {
    this.emit({
      level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
      message: `${method} ${path} ${status} ${duration}ms`,
      timestamp: new Date().toISOString(),
      requestId,
      duration,
      metadata: { method, path, status, ...meta },
    });
  }
}

export const logger = new Logger(
  (typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') ? 'debug' : 'info'
);
