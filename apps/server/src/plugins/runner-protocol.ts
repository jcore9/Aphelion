import { maxPluginLineBytes } from "@aphelion/plugin-sdk";
import { z } from "zod";

export const maxFrameBytes = 8 * maxPluginLineBytes;
export const maxPendingInputBytes = 16 * maxPluginLineBytes;

const plugin = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const run = z.int().min(1);
const line = z.string().max(maxPluginLineBytes);

export const runnerRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("start"),
    plugin,
    run,
    folder: z.string().startsWith("/").max(4096),
    entry: z.string().min(1).max(1024),
  }),
  z.strictObject({ type: z.literal("stop"), plugin, run }),
  z.strictObject({ type: z.literal("input"), plugin, run, line }),
]);

export const runnerReplySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("started"), plugin, run }),
  z.strictObject({
    type: z.literal("start-failed"),
    plugin,
    run,
    reason: z.string().max(1024),
  }),
  z.strictObject({ type: z.literal("output"), plugin, run, line }),
  z.strictObject({ type: z.literal("log"), plugin, run, line }),
  z.strictObject({
    type: z.literal("exited"),
    plugin,
    run,
    code: z.int().nullable(),
    signal: z.string().max(32).nullable(),
  }),
  z.strictObject({ type: z.literal("stopped"), plugin, run }),
]);

export type RunnerRequest = z.infer<typeof runnerRequestSchema>;
export type RunnerReply = z.infer<typeof runnerReplySchema>;
export type StartRequest = Extract<RunnerRequest, { type: "start" }>;
