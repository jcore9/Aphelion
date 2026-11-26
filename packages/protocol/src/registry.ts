import { z } from "zod";
import { botEventPayload } from "./bot-events.ts";

export const commands = {
  ping: {
    payload: z.strictObject({}),
    result: z.strictObject({}),
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
