import {
  adapterEnvelope,
  maxPluginLineBytes,
  sessionRef,
  turnCancelParams,
  turnStartParams,
} from "@aphelion/plugin-sdk";
import { z } from "zod";

export const maxFrameBytes = 8 * maxPluginLineBytes;

const bot = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const run = z.int().min(1);
const absolutePath = z.string().startsWith("/").max(4096);
const { turn } = turnStartParams.shape;

export const runnerRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("start"),
    bot,
    run,
    provider: bot,
    adapter: absolutePath,
    folder: absolutePath,
    resume: sessionRef.nullable(),
  }),
  z.strictObject({
    type: z.literal("turn.start"),
    bot,
    run,
    ...turnStartParams.shape,
  }),
  z.strictObject({
    type: z.literal("turn.cancel"),
    bot,
    run,
    ...turnCancelParams.shape,
  }),
  z.strictObject({ type: z.literal("stop"), bot, run }),
]);

export const turnRefusal = z.enum([
  "not-running",
  "busy",
  "ended",
  "too-long",
  "refused",
]);

export const runnerNotice = z.enum([
  "line-too-long",
  "not-a-message",
  "stopped-reading",
  "too-much-log",
]);

export const runnerReplySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("spawned"), bot, run }),
  z.strictObject({ type: z.literal("started"), bot, run }),
  z.strictObject({
    type: z.literal("start-failed"),
    bot,
    run,
    stage: z.enum(["spawn", "initialize"]),
    reason: z.string().max(1024),
  }),
  z.strictObject({ type: z.literal("turn.accepted"), bot, run, turn }),
  z.strictObject({
    type: z.literal("turn.refused"),
    bot,
    run,
    turn,
    reason: turnRefusal,
  }),
  z.strictObject({
    type: z.literal("event"),
    bot,
    run,
    envelope: adapterEnvelope,
  }),
  z.strictObject({
    type: z.literal("log"),
    bot,
    run,
    line: z.string().max(maxPluginLineBytes),
  }),
  z.strictObject({ type: z.literal("notice"), bot, run, code: runnerNotice }),
  z.strictObject({
    type: z.literal("exited"),
    bot,
    run,
    code: z.int().nullable(),
    signal: z.string().max(32).nullable(),
  }),
  z.strictObject({ type: z.literal("stopped"), bot, run }),
]);

export type RunnerRequest = z.infer<typeof runnerRequestSchema>;
export type RunnerReply = z.infer<typeof runnerReplySchema>;
export type StartRequest = Extract<RunnerRequest, { type: "start" }>;
export type TurnRefusal = z.infer<typeof turnRefusal>;
export type RunnerNotice = z.infer<typeof runnerNotice>;
