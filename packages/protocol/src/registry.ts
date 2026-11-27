import { z } from "zod";
import { botEventPayload, botName, turnId } from "./bot-events.ts";

const maxHistoryLimit = 500;
export const maxPromptLength = 256 * 1024;

export const commands = {
  ping: {
    payload: z.strictObject({}),
    result: z.strictObject({}),
  },
  "bot.prompt": {
    payload: z.strictObject({
      bot: botName.describe("The bot to give the prompt to."),
      text: z
        .string()
        .min(1)
        .max(maxPromptLength)
        .describe(
          "The prompt. The server refuses one over 256 KiB of UTF-8, or one whose line to the bot is over 1 MiB after JSON escapes, with `prompt-too-long`.",
        ),
    }),
    result: z.strictObject({
      turn: turnId.describe(
        "The turn the bot started. A repeat of the command returns the same turn.",
      ),
    }),
  },
  "bot.cancel": {
    payload: z.strictObject({
      bot: botName.describe("The bot that runs the turn."),
      turn: turnId.describe("The turn to cancel."),
    }),
    result: z.strictObject({}),
  },
  "history.read": {
    payload: z.strictObject({
      bot: botName.describe("The bot to read events of."),
      after: z
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Read the events after this position. Leave it out to start at the oldest event.",
        ),
      limit: z
        .int()
        .min(1)
        .max(maxHistoryLimit)
        .describe("The most saved events to read, from 1 to 500."),
    }),
    result: z.strictObject({
      events: z
        .array(
          z.strictObject({
            seq: z
              .int()
              .positive()
              .describe("The event's position, as in an event frame."),
            payload: botEventPayload.describe(
              "The same payload an event frame carries.",
            ),
          }),
        )
        .describe(
          "The events the client may see, in order. A page holds at most 256 KiB of encoded events. It can hold fewer than `limit`, or none, while `more` is `true`.",
        ),
      next: z
        .int()
        .nonnegative()
        .describe(
          "The position to send as `after` to read the next page. It can be higher than the last event, because the server skips events a client never sees.",
        ),
      more: z
        .boolean()
        .describe(
          "Whether the server holds more saved events of this bot after `next`.",
        ),
    }),
  },
} satisfies Record<string, { payload: z.ZodType; result: z.ZodType }>;

export const events = {
  notice: z
    .strictObject({
      message: z.string().describe("Text for a person to read."),
    })
    .describe("A message for every client to show."),
  "bot.event": botEventPayload,
} satisfies Record<string, z.ZodType>;
