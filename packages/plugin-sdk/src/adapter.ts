import { z } from "zod";
import type { MaybePromise } from "./plugin.ts";

/** The bot adapter API version that this SDK runs, such as `0.1.0`. A new event or field raises the minor version. A changed or removed one raises the major version. */
export const adapterApiVersion = "0.1.0";

const utf8 = new TextEncoder();

const bytes = (text: string) => utf8.encode(text).byteLength;

const boundedText = (maxBytes: number, minBytes = 0) =>
  z
    .string()
    .refine((text) => bytes(text) <= maxBytes && bytes(text) >= minBytes, {
      error: `must be ${String(minBytes)} to ${String(maxBytes)} bytes`,
    });

/** The Zod schema for a turn's id. The bot runner picks it. It is 1 to 64 letters, digits, `_` or `-`. */
export const turnId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .brand<"TurnId">();
/** The id of one turn, the bot's work on one prompt. */
export type TurnId = z.infer<typeof turnId>;

/** The Zod schema for a tool call's id. The adapter picks it, usually the vendor's own id. It is 1 to 128 letters, digits, `_`, `.`, `:` or `-`. */
export const toolCallId = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
  .brand<"ToolCallId">();
/** The id of one tool call. */
export type ToolCallId = z.infer<typeof toolCallId>;

/** The Zod schema for a permission request's id. The adapter picks it. It has the same form as a tool call's id. */
export const permissionRequestId = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
  .brand<"PermissionRequestId">();
/** The id of one permission request. */
export type PermissionRequestId = z.infer<typeof permissionRequestId>;

/** The Zod schema for the vendor's session id. The id is opaque: 1 to 256 printable ASCII characters, with no space and no `/`, so it can't be a path or a command with arguments. Vendor session ids are UUID-like. */
export const sessionRef = z
  .string()
  .regex(/^[\x21-\x2e\x30-\x7e]{1,256}$/)
  .brand<"SessionRef">();
/** The vendor's id for a session, which the bot runner saves so the bot can resume it. */
export type SessionRef = z.infer<typeof sessionRef>;

const toolName = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

/** The Zod schema for a tool's kind. The adapter maps each vendor tool to one kind, and a tool it doesn't know is `other`. */
export const toolKind = z.enum([
  "file.read",
  "file.write",
  "shell",
  "web",
  "other",
]);
/** What a tool does, in terms that don't depend on the vendor. */
export type ToolKind = z.infer<typeof toolKind>;

const decisionValue = z.enum(["allow", "deny"]);
const decidedBy = z.enum(["rule", "policy", "owner", "default"]);
/** The Zod schema for the reason of a permission decision. It is a fixed code, never text. A new code is a minor version bump. */
export const reasonCode = z.enum([
  "inside-folder",
  "outside-folder",
  "web",
  "shell",
  "unknown-tool",
  "cancelled",
  "turn-ended",
  "timeout",
  "shutdown",
  "no-decider",
  "invalid-request",
  "duplicate-request",
  "invalid-decision",
  "decider-failed",
]);
/** Why a permission was allowed or denied. */
export type ReasonCode = z.infer<typeof reasonCode>;

const count = z.int().nonnegative();

const sessionEvent = z.strictObject({
  type: z.literal("session"),
  ref: sessionRef,
});

const textDeltaEvent = z.strictObject({
  type: z.literal("text.delta"),
  text: boundedText(16 * 1024, 1),
});

const toolStartEvent = z.strictObject({
  type: z.literal("tool.start"),
  call: toolCallId,
  tool: toolName,
  kind: toolKind,
});

const toolEndEvent = z.strictObject({
  type: z.literal("tool.end"),
  call: toolCallId,
  outcome: z.enum(["ok", "error", "denied", "cancelled"]),
});

const usageEvent = z.strictObject({
  type: z.literal("usage"),
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  costUsd: z.number().nonnegative().nullable(),
});

const errorEvent = z.strictObject({
  type: z.literal("error"),
  code: z.enum([
    "cli-not-found",
    "cli-exited",
    "signed-out",
    "rate-limited",
    "vendor",
    "adapter",
  ]),
});

const turnEndEvent = z.strictObject({
  type: z.literal("turn.end"),
  reason: z.enum([
    "completed",
    "cancelled",
    "denied",
    "limit",
    "refused",
    "error",
  ]),
});

const permissionRequestEvent = z.strictObject({
  type: z.literal("permission.request"),
  request: permissionRequestId,
  call: toolCallId.nullable(),
  tool: toolName,
  kind: toolKind,
  pathCount: z.int().min(0).max(32),
  hasCommand: z.boolean(),
});

const permissionDecisionEvent = z.strictObject({
  type: z.literal("permission.decision"),
  request: permissionRequestId,
  decision: decisionValue,
  by: decidedBy,
  reason: reasonCode,
});

/**
 * The Zod schema for an event that an adapter yields. The runtime adds `seq` and `turn`.
 * No field can hold a command, a path or free text, except the text of `text.delta`.
 */
export const adapterEvent = z.discriminatedUnion("type", [
  sessionEvent,
  textDeltaEvent,
  toolStartEvent,
  toolEndEvent,
  usageEvent,
  errorEvent,
  turnEndEvent,
]);
/** An event that an adapter yields: `session`, `text.delta`, `tool.start`, `tool.end`, `usage`, `error` or `turn.end`. */
export type AdapterEvent = z.infer<typeof adapterEvent>;

/** The Zod schema for every event that leaves the bot process. It adds `permission.request` and `permission.decision`, which only the runtime sends. */
export const streamEvent = z.discriminatedUnion("type", [
  sessionEvent,
  textDeltaEvent,
  toolStartEvent,
  toolEndEvent,
  usageEvent,
  errorEvent,
  turnEndEvent,
  permissionRequestEvent,
  permissionDecisionEvent,
]);
/** An event as it leaves the bot process. */
export type StreamEvent = z.infer<typeof streamEvent>;

/**
 * The Zod schema for the params of the `event` notification: `seq`, the turn's id and the event.
 * `turn` is `null` only for `session` and for an `error` outside a turn.
 */
export const adapterEnvelope = z
  .strictObject({
    seq: z.int().min(1),
    turn: turnId.nullable(),
    event: streamEvent,
  })
  .refine(
    ({ turn, event }) =>
      turn !== null || event.type === "session" || event.type === "error",
    { error: "only session and error events may have no turn" },
  );
/** One event on the wire, with its number and its turn. */
export type AdapterEnvelope = z.infer<typeof adapterEnvelope>;

/** The Zod schema for a permission request as the adapter hands it to `decide`. The paths and the command stay in memory and never go into an event. */
export const permissionRequest = z.strictObject({
  request: permissionRequestId,
  call: toolCallId.nullable(),
  tool: toolName,
  kind: toolKind,
  paths: z.array(boundedText(4096)).max(32),
  command: boundedText(4096).nullable(),
  truncated: z.boolean(),
});
/** What an adapter asks before a tool runs. `truncated` is true when the adapter cut a path list or a command to fit. */
export type PermissionRequest = z.infer<typeof permissionRequest>;

/** The Zod schema for the answer to a permission request. `reason` is one of a fixed list of codes, such as `outside-folder`, never text. */
export const permissionDecision = z.strictObject({
  decision: decisionValue,
  by: decidedBy,
  reason: reasonCode,
});
/** The answer to one permission request. It covers that request only, never a whole session. */
export type PermissionDecision = z.infer<typeof permissionDecision>;

/** The methods that the bot runner and the adapter send over their JSON lines. `permissionAsk` is reserved for M2. */
export const adapterMethods = {
  initialize: "initialize",
  turnStart: "turn.start",
  turnCancel: "turn.cancel",
  shutdown: "shutdown",
  event: "event",
  permissionAsk: "permission.ask",
} as const;

const absoluteFolder = z
  .string()
  .max(4096)
  .regex(/^(\/|[A-Za-z]:[\\/])/);

/** The Zod schema for the params of the bot runner's `initialize` request. */
export const adapterInitializeParams = z.strictObject({
  api: z.string().min(1).max(64),
  bot: z.strictObject({ id: z.string().min(1).max(128) }),
  folder: absoluteFolder,
  resume: sessionRef.nullable(),
});

/** The Zod schema for the params of the bot runner's `turn.start` request. The prompt is at most 256 KiB. */
export const turnStartParams = z.strictObject({
  turn: turnId,
  text: boundedText(256 * 1024),
});

/** The Zod schema for the params of the bot runner's `turn.cancel` request. */
export const turnCancelParams = z.strictObject({ turn: turnId });

/** What an adapter receives when the bot runner starts it. */
export interface AdapterContext {
  /** The bot the adapter runs for. */
  readonly bot: { readonly id: string };
  /** The absolute path of the folder the vendor's CLI works in. */
  readonly folder: string;
  /** The vendor session to resume, or `null` to start a new one. */
  readonly resume: SessionRef | null;
  /** Writes a message to the server's log. Never pass event payloads. */
  log(message: string): void;
}

/** The prompt the bot runner sends for one turn. */
export interface TurnInput {
  /** The turn's id. */
  readonly turn: TurnId;
  /** The prompt, at most 256 KiB. */
  readonly text: string;
  /**
   * Asks whether a tool may run in this turn. The runtime puts `permission.request` and `permission.decision` on the stream, so the adapter reports nothing itself.
   * It always resolves. A request that is invalid, comes after this turn ended, after a cancel or after shutdown began, or isn't answered in time resolves as `deny`. The ones that can't be asked send no event.
   */
  readonly decide: (request: PermissionRequest) => Promise<PermissionDecision>;
}

/** One running conversation with the vendor's CLI. */
export interface AdapterSession {
  /**
   * Runs one prompt and yields the turn's events in order, ending with exactly one `turn.end`.
   * `signal` aborts when the turn is cancelled or fails. The adapter stops the vendor's work, and may still yield `turn.end` and `tool.end`.
   * A `tool.end` may come after `turn.end`, from this stream or from a later turn's stream, for a call that is still running.
   */
  turn(input: TurnInput, signal: AbortSignal): AsyncIterable<AdapterEvent>;
  /** Closes the vendor's session. The runtime calls it once on shutdown. */
  close?(): MaybePromise<void>;
}

/** What a bot tool implements: a function from one prompt to a stream of normalized events. */
export interface BotAdapter {
  /** The provider's name. It matches the bot's `provider` and the manifest's `contributes.botAdapter.provider`. */
  readonly provider: string;
  /** Opens a session. The runtime calls it once, when the bot runner sends `initialize`. */
  open(context: AdapterContext): MaybePromise<AdapterSession>;
}

/** What a decider knows about the bot it answers for. */
export interface DeciderContext {
  /** The absolute path of the bot's folder, as the bot runner sent it in `initialize`. */
  readonly folder: string;
}

/** Answers permission requests. It gets the turn's signal, which aborts on cancel and when the turn ends, and the bot's folder. */
export type Decider = (
  request: PermissionRequest,
  signal: AbortSignal,
  context: DeciderContext,
) => MaybePromise<PermissionDecision>;

/** A `Decider` that denies every request with `by: "default"`. */
export const denyAll: Decider = () => ({
  decision: "deny",
  by: "default",
  reason: "no-decider",
});
