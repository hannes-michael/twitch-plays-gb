import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { ChatTimings } from './chat';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const CONFIG_DEFAULTS = {
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'info',
  dev: false,
  test: false,
  timings: {
    democracyWindowMs: 15_000,
    holdFrames: 8,
    releaseFrames: 4,
    inputCooldownMs: 3_000,
    inputMaxQueue: 10,
    inputMaxPerSecond: 5,
    inputStaleMs: 5_000,
    autosaveIntervalMs: 60_000,
  },
  chat: {
    bareCommands: false,
    source: 'auto',
  },
} as const;

export const CHAT_SOURCES = ['auto', 'fake', 'twitch'] as const;
export type ChatSourcePreference = (typeof CHAT_SOURCES)[number];

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

const ROM_EXTENSIONS = new Set(['.gb', '.gbc', '.gba']);

const romValue = z
  .string()
  .trim()
  .min(1, 'expected a ROM path')
  .transform((value) => resolve(value))
  .refine((value) => ROM_EXTENSIONS.has(extname(value).toLowerCase()), {
    message: 'expected a .gb, .gbc, or .gba file',
  })
  .refine(existsSync, { message: 'ROM file does not exist' });

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

function timingValue(min: number, max: number, fallback: number) {
  return z
    .union([z.number(), z.string()])
    .transform((value, ctx) => {
      if (typeof value === 'string' && value.trim() === '') return fallback;
      const parsed = typeof value === 'number' ? value : Number(value);
      if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        ctx.addIssue({
          code: 'custom',
          message: `expected an integer between ${min} and ${max}, received ${JSON.stringify(value)}`,
        });
        return z.NEVER;
      }
      return parsed;
    })
    .default(fallback);
}

const TimingsSchema = z
  .object({
    democracyWindowMs: timingValue(1, 3_600_000, CONFIG_DEFAULTS.timings.democracyWindowMs),
    holdFrames: timingValue(1, 600, CONFIG_DEFAULTS.timings.holdFrames),
    releaseFrames: timingValue(1, 600, CONFIG_DEFAULTS.timings.releaseFrames),
    inputCooldownMs: timingValue(0, 3_600_000, CONFIG_DEFAULTS.timings.inputCooldownMs),
    inputMaxQueue: timingValue(1, 1_000, CONFIG_DEFAULTS.timings.inputMaxQueue),
    inputMaxPerSecond: timingValue(1, 1_000, CONFIG_DEFAULTS.timings.inputMaxPerSecond),
    inputStaleMs: timingValue(0, 3_600_000, CONFIG_DEFAULTS.timings.inputStaleMs),
    autosaveIntervalMs: timingValue(100, 3_600_000, CONFIG_DEFAULTS.timings.autosaveIntervalMs),
  })
  .strict()
  .default({ ...CONFIG_DEFAULTS.timings });

const chatSourceValue = z
  .string()
  .transform((value, ctx) => {
    const normalized = value.trim().toLowerCase();
    if ((CHAT_SOURCES as readonly string[]).includes(normalized)) {
      return normalized as ChatSourcePreference;
    }
    ctx.addIssue({
      code: 'custom',
      message: `expected one of ${CHAT_SOURCES.join(', ')}, received ${JSON.stringify(value)}`,
    });
    return z.NEVER;
  })
  .default(CONFIG_DEFAULTS.chat.source);

const ChatSchema = z
  .object({
    bareCommands: booleanValue.default(CONFIG_DEFAULTS.chat.bareCommands),
    source: chatSourceValue,
  })
  .strict()
  .default({ ...CONFIG_DEFAULTS.chat });

const ConfigSchema = z
  .object({
    host: z.string().trim().min(1).default(CONFIG_DEFAULTS.host),
    port: portValue,
    dataDir: z.string().trim().min(1),
    rom: romValue.optional(),
    channel: optionalString,
    dev: booleanValue.default(CONFIG_DEFAULTS.dev),
    test: booleanValue.default(CONFIG_DEFAULTS.test),
    logLevel: logLevelValue,
    timings: TimingsSchema,
    chat: ChatSchema,
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
  --data-dir <path>      Data directory (default: data/dev in dev, platform-specific otherwise)
  --config <path>        JSON config file (default: <dataDir>/config.json)
  --rom <path>           Game Boy, GBC, or GBA ROM to boot (.gb/.gbc/.gba)
  --channel <name>       Twitch channel name
  --log-level <level>    debug | info | warn | error (default: info)
  --democracy-window-ms <ms>  Democracy vote window (default: 15000)
  --hold-frames <frames>      Frames to hold an input (default: 8)
  --release-frames <frames>   Frames to release an input (default: 4)
  --input-cooldown-ms <ms>    Per-user chat input cooldown (default: 3000)
  --input-max-queue <count>   Maximum queued inputs (default: 10)
  --input-max-per-second <n>  Global accepted inputs per second (default: 5)
  --input-stale-ms <ms>       Drop inputs older than this at execution (default: 5000)
  --autosave-interval-ms <ms> Emulator autosave interval (default: 60000, min: 100)
  --bare-commands[=<bool>]    Accept input commands without the ! prefix
  --chat <source>             auto | fake | twitch (default: auto)
  --dev[=<bool>]         Enable development mode and Vite middleware
  --test[=<bool>]        Enable test mode and Vite middleware
  -h, --help             Show this help

Environment: HOST, PORT, TPG_HOST, TPG_PORT, TPG_DATA_DIR, TPG_CONFIG,
TPG_ROM, TPG_CHANNEL, TPG_DEV, TPG_TEST, TPG_LOG_LEVEL,
TPG_DEMOCRACY_WINDOW_MS, TPG_HOLD_FRAMES, TPG_RELEASE_FRAMES,
TPG_INPUT_COOLDOWN_MS, TPG_INPUT_MAX_QUEUE, TPG_INPUT_MAX_PER_SECOND,
TPG_INPUT_STALE_MS, TPG_AUTOSAVE_INTERVAL_MS, TPG_BARE_COMMANDS, TPG_CHAT`;

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

interface TimingValues {
  democracyWindowMs?: string;
  holdFrames?: string;
  releaseFrames?: string;
  inputCooldownMs?: string;
  inputMaxQueue?: string;
  inputMaxPerSecond?: string;
  inputStaleMs?: string;
  autosaveIntervalMs?: string;
}

interface ChatValues {
  bareCommands?: string;
  source?: string;
}

interface CliValues {
  host?: string;
  port?: string;
  dataDir?: string;
  rom?: string;
  channel?: string;
  dev?: string;
  test?: string;
  logLevel?: string;
  config?: string;
  timings?: TimingValues;
  chat?: ChatValues;
}

const TIMING_FLAGS: Record<string, keyof ChatTimings> = {
  'democracy-window-ms': 'democracyWindowMs',
  'hold-frames': 'holdFrames',
  'release-frames': 'releaseFrames',
  'input-cooldown-ms': 'inputCooldownMs',
  'input-max-queue': 'inputMaxQueue',
  'input-max-per-second': 'inputMaxPerSecond',
  'input-stale-ms': 'inputStaleMs',
  'autosave-interval-ms': 'autosaveIntervalMs',
};

const BOOLEAN_FLAGS = new Set(['dev', 'test', 'bare-commands']);
const VALUE_FLAGS = new Set([
  'host',
  'port',
  'data-dir',
  'rom',
  'channel',
  'log-level',
  'config',
  'chat',
  ...Object.keys(TIMING_FLAGS),
]);

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
      else if (name === 'test') values.test = value;
      else values.chat = { ...values.chat, bareCommands: value };
      continue;
    }

    if (!VALUE_FLAGS.has(name)) {
      throw new ConfigError(`Unknown option: --${name}. Use --help for usage.`);
    }

    if (
      inlineValue === undefined &&
      (argv[index + 1] === undefined || argv[index + 1].startsWith('--'))
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
      case 'rom':
        values.rom = value;
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
      case 'chat':
        values.chat = { ...values.chat, source: value };
        break;
      default: {
        const timingKey = TIMING_FLAGS[name];
        if (timingKey) values.timings = { ...values.timings, [timingKey]: value };
        break;
      }
    }
  }

  return values;
}

function readEnv(env: NodeJS.ProcessEnv): CliValues {
  const values: CliValues = {};

  const host = env.TPG_HOST ?? env.HOST;
  if (host !== undefined && host !== '') values.host = host;

  const port = env.TPG_PORT ?? env.PORT;
  if (port !== undefined && port !== '') values.port = port;

  if (env.TPG_DATA_DIR) values.dataDir = env.TPG_DATA_DIR;
  if (env.TPG_ROM) values.rom = env.TPG_ROM;
  if (env.TPG_CHANNEL) values.channel = env.TPG_CHANNEL;
  if (env.TPG_DEV !== undefined) values.dev = env.TPG_DEV;
  if (env.TPG_TEST !== undefined) values.test = env.TPG_TEST;
  if (env.TPG_LOG_LEVEL) values.logLevel = env.TPG_LOG_LEVEL;

  const timings: TimingValues = {};
  if (env.TPG_DEMOCRACY_WINDOW_MS) timings.democracyWindowMs = env.TPG_DEMOCRACY_WINDOW_MS;
  if (env.TPG_HOLD_FRAMES) timings.holdFrames = env.TPG_HOLD_FRAMES;
  if (env.TPG_RELEASE_FRAMES) timings.releaseFrames = env.TPG_RELEASE_FRAMES;
  if (env.TPG_INPUT_COOLDOWN_MS) timings.inputCooldownMs = env.TPG_INPUT_COOLDOWN_MS;
  if (env.TPG_INPUT_MAX_QUEUE) timings.inputMaxQueue = env.TPG_INPUT_MAX_QUEUE;
  if (env.TPG_INPUT_MAX_PER_SECOND) timings.inputMaxPerSecond = env.TPG_INPUT_MAX_PER_SECOND;
  if (env.TPG_INPUT_STALE_MS) timings.inputStaleMs = env.TPG_INPUT_STALE_MS;
  if (env.TPG_AUTOSAVE_INTERVAL_MS) timings.autosaveIntervalMs = env.TPG_AUTOSAVE_INTERVAL_MS;
  if (Object.keys(timings).length > 0) values.timings = timings;

  const chat: ChatValues = {};
  if (env.TPG_BARE_COMMANDS !== undefined) chat.bareCommands = env.TPG_BARE_COMMANDS;
  if (env.TPG_CHAT) chat.source = env.TPG_CHAT;
  if (Object.keys(chat).length > 0) values.chat = chat;

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

/** Development state stays inside the repository and is git-ignored. */
export function developmentDataDir(cwd: string = process.cwd()): string {
  return resolve(cwd, 'data', 'dev');
}

const TEST_DATA_DIR_ERROR =
  'Test mode requires an explicit data directory. Pass --data-dir <temp-dir> or set ' +
  'TPG_DATA_DIR; refusing to use the default user data directory.';

function flagEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  const explicitDataDir = cli.dataDir ?? envValues.dataDir;
  const preliminaryTest = flagEnabled(cli.test ?? envValues.test);

  // Refuse to read from or write to a real user data directory in test mode.
  // The config file cannot make this safe, so only CLI/env overrides count.
  if (preliminaryTest && explicitDataDir === undefined) {
    throw new ConfigError(TEST_DATA_DIR_ERROR);
  }

  const preliminaryDev = !preliminaryTest && flagEnabled(cli.dev ?? envValues.dev);
  const baseDataDir =
    explicitDataDir ?? (preliminaryDev ? developmentDataDir() : defaultDataDir(env));
  const configuredPath = (cli.config ?? env.TPG_CONFIG)?.trim() || undefined;
  const configPath = resolve(configuredPath ?? join(baseDataDir, 'config.json'));
  const fileValues = readConfigFile(configPath, configuredPath !== undefined);

  const { config: _configPath, ...cliValues } = cli;
  const fileTimings = fileValues.timings;
  const timingOverrides = { ...envValues.timings, ...cliValues.timings };
  const fileChat = fileValues.chat;
  const chatOverrides = { ...envValues.chat, ...cliValues.chat };
  const merged = {
    dataDir: baseDataDir,
    ...fileValues,
    ...envValues,
    ...cliValues,
    // Let Zod reject non-object timing/chat values from JSON instead of
    // silently replacing them with defaults. A valid partial object is merged
    // with env/CLI overrides and Zod fills the remaining fields.
    timings:
      fileTimings === undefined || isPlainObject(fileTimings)
        ? { ...(isPlainObject(fileTimings) ? fileTimings : {}), ...timingOverrides }
        : fileTimings,
    chat:
      fileChat === undefined || isPlainObject(fileChat)
        ? { ...(isPlainObject(fileChat) ? fileChat : {}), ...chatOverrides }
        : fileChat,
  };

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(
      `Invalid configuration: ${formatIssues(result.error)}. Config file: ${configPath}`,
    );
  }

  // The flag may also come from the JSON config, in which case the path was
  // resolved before reading it. Enforce the safety rule either way.
  if (result.data.test && explicitDataDir === undefined) {
    throw new ConfigError(TEST_DATA_DIR_ERROR);
  }

  const usesDevDefault =
    result.data.dev &&
    !result.data.test &&
    explicitDataDir === undefined &&
    fileValues.dataDir === undefined;

  return {
    ...result.data,
    dataDir: usesDevDefault ? developmentDataDir() : result.data.dataDir,
  };
}
