import { z } from "zod";

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
} satisfies Record<string, z.ZodType>;
