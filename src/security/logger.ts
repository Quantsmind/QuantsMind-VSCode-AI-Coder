import { redactSecrets } from './redact';

export interface LogSink {
  appendLine(value: string): void;
}

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Logs only metadata and already-safe messages. Every line is passed through
 * secret redaction as a final guard before it reaches the output channel.
 */
const MAX_LOG_LINES = 300;

export class Logger {
  private readonly ring: string[] = [];

  constructor(
    private readonly sink: LogSink,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string, error?: unknown): void {
    let detail = '';
    if (error instanceof Error) {
      detail = error.name === 'Error' ? error.message : `${error.name}: ${error.message}`;
    } else if (error !== undefined) {
      detail = String(error);
    }
    this.write('error', detail.length > 0 ? `${message} — ${detail}` : message);
  }

  /**
   * Returns the most recent redacted log lines (bounded), for user-initiated
   * "copy logs" actions. Every line reflects exactly what reached the output
   * channel — redacted at write time.
   */
  recentLogLines(max = 50): readonly string[] {
    const limit = Math.max(1, Math.min(Math.floor(max), MAX_LOG_LINES));
    return this.ring.slice(-limit);
  }

  private write(level: LogLevel, message: string): void {
    const timestamp = this.clock().toISOString();
    const safe = redactSecrets(`${timestamp} [${level}] ${message}`).text;
    this.sink.appendLine(safe);
    this.ring.push(safe);
    if (this.ring.length > MAX_LOG_LINES) {
      this.ring.shift();
    }
  }
}
