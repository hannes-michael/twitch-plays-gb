import { z } from 'zod';

/** Browser-safe chat contracts shared by the server, UI, and tests. */

export interface ChatRoles {
  broadcaster?: boolean;
  mod?: boolean;
  vip?: boolean;
  bot?: boolean;
  self?: boolean;
}

export interface ChatMessage {
  id: string;
  user: string;
  text: string;
  receivedAt: string;
  channel?: string;
  roles?: ChatRoles;
}

export type ChatSourceKind = 'fake' | 'twitch' | 'none';

export interface ChatStatus {
  source: ChatSourceKind;
  connected: boolean;
  messages: number;
  channel?: string;
  lastError?: string;
}

export interface ChatTimings {
  democracyWindowMs: number;
  holdFrames: number;
  releaseFrames: number;
  inputCooldownMs: number;
  inputMaxQueue: number;
  inputMaxPerSecond: number;
  inputStaleMs: number;
  autosaveIntervalMs: number;
}

export interface ChatOutageRequest {
  outage: boolean;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

const userValue = z
  .string()
  .trim()
  .min(1, 'user is required')
  .max(32, 'user must be at most 32 characters')
  .refine((value) => !hasControlCharacters(value), 'user must not contain control characters');

const textValue = z
  .string()
  .trim()
  .min(1, 'text is required')
  .max(200, 'text must be at most 200 characters')
  .refine((value) => !hasControlCharacters(value), 'text must not contain control characters');

const chatRolesSchema = z
  .object({
    broadcaster: z.boolean().optional(),
    mod: z.boolean().optional(),
    vip: z.boolean().optional(),
    bot: z.boolean().optional(),
    self: z.boolean().optional(),
  })
  .strict()
  .optional();

export const chatMessageInputSchema = z
  .object({
    user: userValue,
    text: textValue,
    roles: chatRolesSchema,
  })
  .strict();

export type ChatMessageInput = z.infer<typeof chatMessageInputSchema>;

export const chatOutageRequestSchema: z.ZodType<ChatOutageRequest> = z
  .object({
    outage: z.boolean(),
  })
  .strict();
