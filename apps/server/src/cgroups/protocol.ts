import { z } from "zod";

export const maxSupervisorFrameBytes = 16 * 1024;

export const runIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const botIdPattern = /^[a-z][a-z0-9-]{0,62}$/;

const run = z.string().max(64);
const path = z.string().startsWith("/").max(4096);
const reason = z.string().max(256);

export const supervisorRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("start"),
    run,
    bot: z.string().max(64),
    adapter: z.string().max(64),
  }),
  z.strictObject({ type: z.literal("kill"), run }),
]);

export const supervisorReplySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready") }),
  z.strictObject({
    type: z.literal("unsafe"),
    step: z.string().max(64),
    errno: z.string().max(64),
  }),
  z.strictObject({
    type: z.literal("started"),
    run,
    stdin: path,
    stdout: path,
    stderr: path,
  }),
  z.strictObject({ type: z.literal("start-failed"), run, reason }),
  z.strictObject({
    type: z.literal("exited"),
    run,
    code: z.int().nullable(),
    signal: z.string().max(32).nullable(),
  }),
  z.strictObject({ type: z.literal("killed"), run }),
  z.strictObject({ type: z.literal("kill-failed"), run, reason }),
]);

export type SupervisorRequest = z.infer<typeof supervisorRequestSchema>;
export type SupervisorReply = z.infer<typeof supervisorReplySchema>;
