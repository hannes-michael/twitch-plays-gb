import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const CONFIG_DEFAULTS = {
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'info',
  dev: false,
  test: false,
} as const;

const booleanValue = z.union([z.boolean(), z.string()]).transform((value, ctx) => {
  if (typeof value === 'boolean') return value;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false;
  ctx.addIssue({
    code: 'custom',
    message: `expected a boolean (1/0, true/false, yes/no, on/off), received ${JSON.stringify(value)}`,
  });
  return z.NEVER;
});

const optionalString = z
  .string()
  .trim()
  .transform((value) => (value === '' ? undefined : value))
  .optional();

const portValue = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    if (typeof value === 'string' && value.trim() === '') {
      return CONFIG_DEFAULTS.port;
    }
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      ctx.addIssue({
        code: 'custom',
        message: `expected an integer between 0 and 65535, received ${JSON.stringify(value)}`,
      });
      return z.NEVER;
    }
    return parsed;
  })
  .default(CONFIG_DEFAULTS.port);

const logLevelValue = z
  .string()
  .transform((value, ctx) => {
    const normalized = value.trim().toLowerCase();
    if ((LOG_LEVELS as readonly string[]).includes(normalized)) {
      return normalized as LogLevel;
    }
    ctx.addIssue({
      code: 'custom',
      message: `expected one of ${LOG_LEVELS.join(', ')}, received ${JSON.stringify(value)}`,
    });
    return z.NEVER;
  })
  .default(CONFIG_DEFAULTS.logLevel);

const ConfigSchema = z
  .object({
    host: z.string().trim().min(1).default(CONFIG_DEFAULTS.host),
    port: portValue,
    dataDir: z.string().trim().min(1),
    channel: optionalString,
    dev: booleanValue.default(CONFIG_DEFAULTS.dev),
    test: booleanValue.default(CONFIG_DEFAULTS.test),
    logLevel: logLevelValue,
  })
  .strict();

export type AppConfig = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const CLI_USAGE = `Usage: twitch-plays-gb [options]

Options:
  --host <host>          Bind address (default: 127.0.0.1)
  --port <port>          Listen port; use 0 for a random port (default: 3000)
  --data-dir <path>      Data directory (default: platform-specific)
  --config <path>        JSON config file (default: <dataDir>/config.json)
  --channel <name>       Twitch channel name
  --log-level <level>    debug | info | warn | error (default: info)
  --dev[=<bool>]         Enable development mode and Vite middleware
  --test[=<bool>]        Enable test mode and Vite middleware
  -h, --help             Show this help

Environment: HOST, PORT, TPG_HOST, TPG_PORT, TPG_DATA_DIR, TPG_CONFIG,
TPG_CHANNEL, TPG_DEV, TPG_TEST, TPG_LOG_LEVEL`;

export class HelpRequested extends Error {
  constructor() {
    super(CLI_USAGE);
    this.name = 'HelpRequested';
  }
}

export interface LoadConfigOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}

interface CliValues {
  host?: string;
  port?: string;
  dataDir?: string;
  channel?: string;
  dev?: string;
  test?: string;
  logLevel?: string;
  config?: string;
}

const BOOLEAN_FLAGS = new Set(['dev', 'test']);
const VALUE_FLAGS = new Set(['host', 'port', 'data-dir', 'channel', 'log-level', 'config']);

function parseCliArgs(argv: string[]): CliValues {
  const values: CliValues = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      throw new HelpRequested();
    }

    if (!arg.startsWith('--')) {
      if (arg.startsWith('-')) {
        throw new ConfigError(`Unknown option: ${arg}. Use --help for usage.`);
      }
      throw new ConfigError(`Unexpected command-line argument: ${arg}. Use --help for usage.`);
    }

    if (arg === '--') {
      throw new ConfigError('Unexpected command-line argument: --. Use --help for usage.');
    }

    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    const name = equalsIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : withoutPrefix.slice(equalsIndex + 1);

    if (BOOLEAN_FLAGS.has(name)) {
      const value = inlineValue ?? 'true';
      if (value === '') {
        throw new ConfigError(
          `Missing value for --${name}. Use --${name}=true or --${name}=false.`,
        );
      }
      if (name === 'dev') values.dev = value;
      else values.test = value;
      continue;
    }

    if (!VALUE_FLAGS.has(name)) {
      throw new ConfigError(`Unknown option: --${name}. Use --help for usage.`);
    }

    if (
      inlineValue === undefined &&
      (argv[index + 1] === undefined || argv[index + 1].startsWith('-'))
    ) {
      throw new ConfigError(`Missing value for --${name}. Use --help for usage.`);
    }

    const value = inlineValue ?? argv[++index];
    if (value === undefined || value === '') {
      throw new ConfigError(`Missing value for --${name}. Use --help for usage.`);
    }

    switch (name) {
      case 'host':
        values.host = value;
        break;
      case 'port':
        values.port = value;
        break;
      case 'data-dir':
        values.dataDir = value;
        break;
      case 'channel':
        values.channel = value;
        break;
      case 'log-level':
        values.logLevel = value;
        break;
      case 'config':
        values.config = value;
        break;
    }
  }

  return values;
}

function readEnv(env: NodeJS.ProcessEnv): Partial<Record<keyof CliValues, string>> {
  const values: Partial<Record<keyof CliValues, string>> = {};

  const host = env.TPG_HOST ?? env.HOST;
  if (host !== undefined && host !== '') values.host = host;

  const port = env.TPG_PORT ?? env.PORT;
  if (port !== undefined && port !== '') values.port = port;

  if (env.TPG_DATA_DIR) values.dataDir = env.TPG_DATA_DIR;
  if (env.TPG_CHANNEL) values.channel = env.TPG_CHANNEL;
  if (env.TPG_DEV !== undefined) values.dev = env.TPG_DEV;
  if (env.TPG_TEST !== undefined) values.test = env.TPG_TEST;
  if (env.TPG_LOG_LEVEL) values.logLevel = env.TPG_LOG_LEVEL;

  return values;
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') {
    return join(env.APPDATA ?? homedir(), 'twitch-plays-gb');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'twitch-plays-gb');
  }
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'twitch-plays-gb');
}

function readConfigFile(path: string, required: boolean): Record<string, unknown> {
  let raw: string;

  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (required) {
        throw new ConfigError(`Config file not found: ${path}`);
      }
      return {};
    }
    throw new ConfigError(`Could not read config file ${path}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`Config file ${path} contains invalid JSON: ${(error as Error).message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`Config file ${path} must contain a JSON object.`);
  }

  return parsed as Record<string, unknown>;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : 'config';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Resolves configuration with the documented precedence:
 * command-line flags > environment variables > JSON config > defaults.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;

  const cli = parseCliArgs(argv);
  const envValues = readEnv(env);
  const baseDataDir = cli.dataDir ?? envValues.dataDir ?? defaultDataDir(env);
  const configuredPath = (cli.config ?? env.TPG_CONFIG)?.trim() || undefined;
  const configPath = resolve(configuredPath ?? join(baseDataDir, 'config.json'));
  const fileValues = readConfigFile(configPath, configuredPath !== undefined);

  const { config: _configPath, ...cliValues } = cli;
  const merged = {
    dataDir: baseDataDir,
    ...fileValues,
    ...envValues,
    ...cliValues,
  };

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(
      `Invalid configuration: ${formatIssues(result.error)}. Config file: ${configPath}`,
    );
  }

  return result.data;
}
