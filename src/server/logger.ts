import type { LogLevel } from '../shared/config';

const LEVEL_WEIGHTS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\u001b[36m',
  info: '\u001b[32m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};

const RESET = '\u001b[0m';

export interface LoggerOptions {
  level: LogLevel;
  pretty: boolean;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createLogger({ level, pretty }: LoggerOptions): Logger {
  const threshold = LEVEL_WEIGHTS[level];
  const useColors = pretty && process.stdout.isTTY && process.env.FORCE_COLOR !== '0';

  const write = (entryLevel: LogLevel, message: string): void => {
    if (LEVEL_WEIGHTS[entryLevel] < threshold) return;

    const stream =
      entryLevel === 'warn' || entryLevel === 'error' ? process.stderr : process.stdout;
    const time = new Date().toISOString();

    if (pretty) {
      const label = entryLevel.toUpperCase().padEnd(5);
      const color = useColors ? LEVEL_COLORS[entryLevel] : '';
      const reset = useColors ? RESET : '';
      stream.write(`[${time.slice(11, 19)}] ${color}${label}${reset} ${message}\n`);
      return;
    }

    stream.write(`${JSON.stringify({ time, level: entryLevel, msg: message })}\n`);
  };

  return {
    debug: (message) => write('debug', message),
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  };
}
