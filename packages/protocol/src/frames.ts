import { z } from "zod";
import { commands, events } from "./registry.ts";

export const version = 1;

const token = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, {
  error: "must be 1 to 64 letters, digits, hyphens or underscores",
});

export const commandId = token.brand<"CommandId">().meta({
  id: "CommandId",
  description:
    "Names one command. The client picks it, and a retry sends the same id.",
});
export type CommandId = z.infer<typeof commandId>;

export const streamId = token.brand<"StreamId">().meta({
  id: "StreamId",
  description:
    "Names one event stream. A server's stream is its server ID, which a restart keeps.",
});
export type StreamId = z.infer<typeof streamId>;

const seq = z.int().nonnegative();

export const cursor = z
  .strictObject({
    stream: streamId.describe("The stream that the position is in."),
    seq: seq.describe("The position of the last event the client has seen."),
  })
  .meta({
    id: "Cursor",
    description: "A position in an event stream.",
  });
export type Cursor = z.infer<typeof cursor>;

export const errorCodes = ["malformed", "unsupported-version"] as const;
export type ErrorCode = (typeof errorCodes)[number];

type Commands = typeof commands;
type Events = typeof events;
export type CommandName = keyof Commands;
export type EventName = keyof Events;

type Envelope<Type extends string> = { v: typeof version; type: Type };

export type CommandFrame = {
  [N in CommandName]: Envelope<"command"> & {
    id: CommandId;
    name: N;
    payload: z.infer<Commands[N]["payload"]>;
  };
}[CommandName];

export type ResultFrame = {
  [N in CommandName]: Envelope<"result"> & {
    id: CommandId;
    name: N;
    result: z.infer<Commands[N]["result"]>;
  };
}[CommandName];

export type EventBody = {
  [N in EventName]: { name: N; payload: z.infer<Events[N]> };
}[EventName];

export type EventFrame = Envelope<"event"> & { seq: number } & EventBody;
export type ResumeFrame = Envelope<"resume"> & { cursor: Cursor | null };
export type ResyncFrame = Envelope<"resync"> & { cursor: Cursor };
export type FrameError = { code: ErrorCode; message: string; id?: CommandId };
export type ErrorFrame = Envelope<"error"> & FrameError;

export type ClientFrame = CommandFrame | ResumeFrame;
export type ServerFrame = ResultFrame | EventFrame | ResyncFrame | ErrorFrame;

function envelope<Type extends string, Shape extends z.ZodRawShape>(
  type: Type,
  description: string,
  shape: Shape,
) {
  return z
    .strictObject({
      v: z.literal(version).describe("The protocol version."),
      type: z.literal(type).describe("The frame type."),
      ...shape,
    })
    .describe(description);
}

function byName<Spec>(
  registry: Record<string, Spec>,
  frame: (name: string, spec: Spec) => z.ZodObject,
) {
  const [first, ...rest] = Object.entries(registry).map(([name, spec]) =>
    frame(name, spec),
  );
  if (!first) throw new Error("a registry needs at least one entry");
  return z.discriminatedUnion("name", [first, ...rest]);
}

const commandFrame = byName(commands, (name, spec) =>
  envelope("command", "Asks the server to run a command.", {
    id: commandId.describe("The client picks it. A retry sends the same id."),
    name: z.literal(name).describe("The command to run."),
    payload: spec.payload.describe("The command's input."),
  }),
);

const resultFrame = byName(commands, (name, spec) =>
  envelope("result", "Answers a command that succeeded.", {
    id: commandId.describe("The id of the command this frame answers."),
    name: z.literal(name).describe("The command that ran."),
    result: spec.result.describe("The command's output."),
  }),
);

const eventFrames = byName(events, (name, payload) =>
  envelope("event", "Tells every client that something happened.", {
    seq: seq.positive().describe("The event's position in the stream."),
    name: z.literal(name).describe("The kind of event."),
    payload: payload.describe("What happened."),
  }),
);

export const eventFrame = eventFrames as unknown as z.ZodType<EventFrame>;

export const clientFrame = z.discriminatedUnion("type", [
  commandFrame,
  envelope("resume", "Asks for the events the client missed.", {
    cursor: cursor
      .nullable()
      .describe("The client's position, or null when it has none."),
  }),
]) as unknown as z.ZodType<ClientFrame>;

export const serverFrame = z.discriminatedUnion("type", [
  resultFrame,
  eventFrames,
  envelope("resync", "Tells a client that it can't catch up.", {
    cursor: cursor.describe("Where the client continues after it reloads."),
  }),
  envelope("error", "Rejects a frame.", {
    code: z.enum(errorCodes).describe("Why the frame was rejected."),
    message: z.string().describe("Fixed text that is safe to log."),
    id: commandId
      .optional()
      .describe("The rejected command's id, when it had a valid one."),
  }),
]) as unknown as z.ZodType<ServerFrame>;

export type Parsed<Frame> =
  { ok: true; frame: Frame } | { ok: false; error: FrameError };

export const parseClientFrame = (text: string) => parseFrame(clientFrame, text);
export const parseServerFrame = (text: string) => parseFrame(serverFrame, text);

export function encodeFrame(frame: ClientFrame | ServerFrame): string {
  return JSON.stringify(frame);
}

const reasons: Partial<Record<z.core.$ZodIssue["code"], string>> = {
  invalid_type: "wrong type or missing",
  invalid_value: "not an allowed value",
  invalid_union: "not an allowed value",
  unrecognized_keys: "unknown field",
  too_small: "out of range",
  too_big: "out of range",
  invalid_format: "wrong format",
};

function parseFrame<Frame>(
  schema: z.ZodType<Frame>,
  text: string,
): Parsed<Frame> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return failure("malformed", "frame is not valid JSON");
  }
  const fields = typeof raw === "object" && raw !== null ? raw : {};
  const id = "id" in fields ? commandId.safeParse(fields.id).data : undefined;
  if ("v" in fields && fields.v !== version) {
    return failure(
      "unsupported-version",
      `unsupported frame version; expected v ${String(version)}`,
      id,
    );
  }
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, frame: result.data };
  const message = result.error.issues
    .map(({ path, code }) => {
      const reason = reasons[code] ?? "invalid";
      return path.length ? `${path.join(".")}: ${reason}` : reason;
    })
    .join("; ");
  return failure("malformed", message, id);
}

function failure(
  code: ErrorCode,
  message: string,
  id?: CommandId,
): { ok: false; error: FrameError } {
  return { ok: false, error: id ? { code, message, id } : { code, message } };
}
