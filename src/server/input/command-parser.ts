import type { InputButton } from '../../shared/input';

export type MetaCommand = 'mode' | 'pause' | 'resume' | 'save';

export type ParsedChatCommand =
  { kind: 'input'; button: InputButton } | { kind: 'meta'; command: MetaCommand; arg?: string };

export interface CommandParserOptions {
  bareCommands: boolean;
}

const INPUT_ALIASES: Readonly<Record<string, InputButton>> = {
  up: 'UP',
  u: 'UP',
  down: 'DOWN',
  d: 'DOWN',
  left: 'LEFT',
  right: 'RIGHT',
  a: 'A',
  b: 'B',
  start: 'START',
  st: 'START',
  select: 'SELECT',
  sel: 'SELECT',
  l: 'L',
  r: 'R',
};

const META_COMMANDS = new Set<string>(['mode', 'pause', 'resume', 'save']);

/**
 * Parses a chat message into an input or meta command. Everything else is
 * invalid and must be ignored. Meta execution is intentionally left to the
 * mode-switching/pause work; this cycle only recognizes and ignores it.
 */
export function parseChatCommand(
  text: string,
  options: CommandParserOptions,
): ParsedChatCommand | null {
  let value = text.trim();
  if (!value) return null;

  if (value.startsWith('!')) {
    value = value.slice(1).trim();
  } else if (!options.bareCommands) {
    return null;
  }
  if (!value) return null;

  const [rawCommand, ...rest] = value.split(/\s+/);
  const command = rawCommand.toLowerCase();

  const button = INPUT_ALIASES[command];
  if (button) {
    // Input commands are single-token; `!right now` is not a valid button.
    return rest.length === 0 ? { kind: 'input', button } : null;
  }

  if (META_COMMANDS.has(command)) {
    const arg = rest.join(' ').trim();
    return {
      kind: 'meta',
      command: command as MetaCommand,
      ...(arg ? { arg } : {}),
    };
  }

  return null;
}
