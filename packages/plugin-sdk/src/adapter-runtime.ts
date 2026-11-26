import {
  adapterApiVersion,
  adapterEnvelope,
  adapterEvent,
  adapterInitializeParams,
  adapterMethods,
  denyAll,
  permissionDecision,
  permissionRequest,
  turnCancelParams,
  turnStartParams,
  type AdapterSession,
  type BotAdapter,
  type Decider,
  type PermissionDecision,
  type PermissionRequest,
  type PermissionRequestId,
  type ReasonCode,
  type StreamEvent,
  type ToolCallId,
  type TurnId,
  type TurnInput,
} from "./adapter.ts";
import type { PluginIO } from "./plugin.ts";
import { describeError } from "./runtime.ts";
import {
  failure,
  notification,
  rpcErrors,
  rpcMessageSchema,
  success,
  type RpcId,
} from "./wire.ts";

/** What `runAdapter` can be told. */
export interface RunAdapterOptions {
  /** Answers permission requests. The default is `denyAll`. */
  readonly decider?: Decider;
  /** How long a cancelled turn has to end by itself before the runtime ends it with `cancelled`, in milliseconds. The default is 5000. */
  readonly cancelGraceMs?: number;
  /** How long the decider has to answer, in milliseconds. After that the request is denied with reason `timeout`. The default is no deadline. */
  readonly decisionDeadlineMs?: number;
}

const defaultCancelGraceMs = 5000;

interface Ask {
  readonly call: ToolCallId | null;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  resolve(decision: PermissionDecision): void;
}

interface Turn {
  readonly id: TurnId;
  readonly controller: AbortController;
  readonly asks: Map<PermissionRequestId, Ask>;
  readonly denied: { any: boolean; readonly calls: Set<ToolCallId> };
  phase: "running" | "cancelling" | "ended";
  usageSent: boolean;
  cancelTimer: ReturnType<typeof setTimeout> | undefined;
}

interface Call {
  readonly owner: Turn;
  ended: boolean;
}

const deny = (reason: ReasonCode): PermissionDecision => ({
  decision: "deny",
  by: "default",
  reason,
});

function parseLine(line: string) {
  try {
    const parsed = rpcMessageSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const isEmptyDelta = (raw: unknown) =>
  typeof raw === "object" &&
  raw !== null &&
  "type" in raw &&
  raw.type === "text.delta" &&
  "text" in raw &&
  raw.text === "";

/**
 * Runs a bot adapter on the given lines until the bot runner sends `shutdown` or closes its input. Most adapters call `mainAdapter` instead.
 * The runtime numbers events, runs one turn at a time, checks every event with Zod before it sends it, settles each permission request exactly once, and cancels a turn that doesn't end.
 * It rejects when writing a line fails or when the adapter's `open` fails.
 */
export async function runAdapter(
  adapter: BotAdapter,
  io: PluginIO,
  options: RunAdapterOptions = {},
): Promise<void> {
  const decider = options.decider ?? denyAll;
  const cancelGraceMs = options.cancelGraceMs ?? defaultCancelGraceMs;
  const calls = new Map<ToolCallId, Call>();
  const seen = new Set<TurnId>();
  let session: AdapterSession | undefined;
  let closing = false;
  let current: Turn | undefined;
  let seq = 0;
  let writing = Promise.resolve();
  let broken: { readonly error: unknown } | undefined;
  let interrupt: (() => void) | undefined;

  const write = (message: unknown) => {
    const line = JSON.stringify(message);
    writing = writing
      .then(() => {
        if (broken) throw broken.error;
        return io.write(line);
      })
      .catch((error: unknown) => {
        broken ??= { error };
        interrupt?.();
      });
  };

  const emit = (turn: TurnId | null, event: StreamEvent) => {
    const envelope = adapterEnvelope.safeParse({
      seq: seq + 1,
      turn,
      event,
    });
    if (!envelope.success) {
      io.log(`the adapter runtime refused to send a ${event.type} event`);
      return;
    }
    seq += 1;
    write(notification(adapterMethods.event, envelope.data));
  };

  const settleAsk = (
    id: PermissionRequestId,
    turn: Turn,
    decision: PermissionDecision,
    announce: boolean,
  ) => {
    const ask = turn.asks.get(id);
    if (!ask || ask.settled) return;
    ask.settled = true;
    clearTimeout(ask.timer);
    if (announce) {
      emit(turn.id, { type: "permission.decision", request: id, ...decision });
      if (decision.decision === "deny") {
        if (ask.call === null) turn.denied.any = true;
        else turn.denied.calls.add(ask.call);
      }
    }
    ask.resolve(decision);
  };

  const settleAll = (turn: Turn, reason: ReasonCode) => {
    for (const id of turn.asks.keys()) {
      settleAsk(id, turn, deny(reason), true);
    }
  };

  const conclude = (turn: Turn, events: readonly StreamEvent[]) => {
    if (turn.phase === "ended") return;
    settleAll(turn, "turn-ended");
    turn.phase = "ended";
    clearTimeout(turn.cancelTimer);
    for (const event of events) emit(turn.id, event);
    if (current === turn) current = undefined;
  };

  const fail = (turn: Turn, why: string) => {
    if (turn.phase === "ended") return;
    io.log(`turn ${turn.id} failed: ${why}`);
    turn.controller.abort();
    conclude(turn, [
      { type: "error", code: "adapter" },
      { type: "turn.end", reason: "error" },
    ]);
  };

  const cancel = (turn: Turn) => {
    if (turn.phase !== "running") return;
    turn.phase = "cancelling";
    settleAll(turn, "cancelled");
    turn.controller.abort();
    turn.cancelTimer = setTimeout(() => {
      if (turn.phase === "ended") return;
      io.log(
        `turn ${turn.id} didn't end after the cancel, so the runtime ended it`,
      );
      conclude(turn, [{ type: "turn.end", reason: "cancelled" }]);
    }, cancelGraceMs);
  };

  const mayEnd = (call: Call, event: { call: ToolCallId; outcome: string }) =>
    !call.ended &&
    (event.outcome !== "denied" ||
      call.owner.denied.any ||
      call.owner.denied.calls.has(event.call));

  const late = (raw: unknown) => {
    if (closing) return;
    const parsed = adapterEvent.safeParse(raw);
    if (parsed.success && parsed.data.type === "tool.end") {
      const call = calls.get(parsed.data.call);
      if (call && mayEnd(call, parsed.data)) {
        call.ended = true;
        emit(call.owner.id, parsed.data);
        return;
      }
    }
    io.log(
      "the adapter yielded an event after its turn ended, so the runtime dropped it",
    );
  };

  const handle = (turn: Turn, raw: unknown) => {
    if (turn.phase === "ended") {
      late(raw);
      return;
    }
    if (isEmptyDelta(raw)) return;
    const parsed = adapterEvent.safeParse(raw);
    if (!parsed.success) {
      fail(turn, "the adapter yielded an event that isn't valid");
      return;
    }
    const event = parsed.data;
    switch (event.type) {
      case "session":
        emit(null, event);
        return;
      case "text.delta":
      case "error":
        emit(turn.id, event);
        return;
      case "tool.start":
        if (calls.has(event.call)) {
          fail(turn, "the adapter started a call id twice");
          return;
        }
        calls.set(event.call, { owner: turn, ended: false });
        emit(turn.id, event);
        return;
      case "tool.end": {
        const call = calls.get(event.call);
        if (!call || !mayEnd(call, event)) {
          fail(
            turn,
            "the adapter ended a call that isn't running, or denied one with no deny decision",
          );
          return;
        }
        call.ended = true;
        emit(call.owner.id, event);
        return;
      }
      case "usage":
        if (turn.usageSent) {
          fail(turn, "the adapter yielded two usage events");
          return;
        }
        turn.usageSent = true;
        emit(turn.id, event);
        return;
      case "turn.end":
        conclude(turn, [event]);
        return;
    }
  };

  const consume = async (opened: AdapterSession, turn: Turn, text: string) => {
    try {
      const input: TurnInput = {
        turn: turn.id,
        text,
        decide: (raw) => decide(turn, raw),
      };
      for await (const raw of opened.turn(input, turn.controller.signal)) {
        handle(turn, raw);
      }
      if (turn.phase === "cancelling") {
        conclude(turn, [{ type: "turn.end", reason: "cancelled" }]);
      } else {
        fail(turn, "the stream ended without turn.end");
      }
    } catch (error) {
      if (turn.phase === "cancelling") {
        conclude(turn, [{ type: "turn.end", reason: "cancelled" }]);
      } else if (turn.phase === "running") {
        fail(turn, `the stream threw: ${describeError(error)}`);
      }
    }
  };

  const runDecider = async (
    turn: Turn,
    id: PermissionRequestId,
    request: PermissionRequest,
  ) => {
    let decision: PermissionDecision;
    try {
      const answer = permissionDecision.safeParse(
        await decider(request, turn.controller.signal),
      );
      decision = answer.success ? answer.data : deny("invalid-decision");
    } catch {
      decision = deny("decider-failed");
    }
    settleAsk(id, turn, decision, true);
  };

  const decide = (
    turn: Turn,
    raw: PermissionRequest,
  ): Promise<PermissionDecision> => {
    if (closing) return Promise.resolve(deny("shutdown"));
    const parsed = permissionRequest.safeParse(raw);
    if (!parsed.success) return Promise.resolve(deny("invalid-request"));
    const request = parsed.data;
    if (turn.phase === "ended") return Promise.resolve(deny("turn-ended"));
    if (turn.phase === "cancelling") return Promise.resolve(deny("cancelled"));
    const owner = request.call ? calls.get(request.call) : undefined;
    if (owner && owner.owner !== turn) {
      return Promise.resolve(deny("turn-ended"));
    }
    if (turn.asks.has(request.request)) {
      return Promise.resolve(deny("duplicate-request"));
    }
    const answered = new Promise<PermissionDecision>((resolve) => {
      const ask: Ask = {
        call: request.call,
        settled: false,
        timer: undefined,
        resolve,
      };
      if (options.decisionDeadlineMs !== undefined) {
        ask.timer = setTimeout(() => {
          settleAsk(request.request, turn, deny("timeout"), true);
        }, options.decisionDeadlineMs);
      }
      turn.asks.set(request.request, ask);
    });
    emit(turn.id, {
      type: "permission.request",
      request: request.request,
      call: request.call,
      tool: request.tool,
      kind: request.kind,
      pathCount: request.paths.length,
      hasCommand: request.command !== null,
    });
    void runDecider(turn, request.request, request);
    return answered;
  };

  const startTurn = (opened: AdapterSession, id: TurnId, text: string) => {
    seen.add(id);
    const turn: Turn = {
      id,
      controller: new AbortController(),
      asks: new Map(),
      denied: { any: false, calls: new Set() },
      phase: "running",
      usageSent: false,
      cancelTimer: undefined,
    };
    current = turn;
    void consume(opened, turn, text);
  };

  const closeDown = async () => {
    closing = true;
    const turn = current;
    if (turn && turn.phase !== "ended") {
      turn.controller.abort();
      settleAll(turn, "shutdown");
      conclude(turn, [{ type: "turn.end", reason: "cancelled" }]);
    }
    try {
      await session?.close?.();
    } catch (error) {
      io.log(`the adapter's close failed: ${describeError(error)}`);
    }
  };

  const reply = (id: RpcId, result: unknown) => {
    write(success(id, result));
  };
  const refuse = (id: RpcId, error: Parameters<typeof failure>[1]) => {
    write(failure(id, error));
  };

  const input = io.input[Symbol.asyncIterator]();
  const read = () =>
    new Promise<IteratorResult<string>>((resolve, reject) => {
      interrupt = () => {
        resolve({ done: true, value: undefined });
      };
      input.next().then(resolve, reject);
    });

  const request = async (id: RpcId, method: string, params: unknown) => {
    switch (method) {
      case adapterMethods.initialize: {
        const parsed = adapterInitializeParams.safeParse(params);
        if (session || !parsed.success) {
          refuse(
            id,
            session ? rpcErrors.invalidRequest : rpcErrors.invalidParams,
          );
          return false;
        }
        try {
          session = await adapter.open({
            bot: parsed.data.bot,
            folder: parsed.data.folder,
            resume: parsed.data.resume,
            log: (message) => {
              io.log(message);
            },
          });
        } catch (error) {
          io.log(`the adapter's open failed: ${describeError(error)}`);
          refuse(id, rpcErrors.operationFailed);
          throw error;
        }
        reply(id, { api: adapterApiVersion, provider: adapter.provider });
        return false;
      }
      case adapterMethods.turnStart: {
        const parsed = turnStartParams.safeParse(params);
        if (!session) {
          refuse(id, rpcErrors.invalidRequest);
        } else if (!parsed.success) {
          refuse(id, rpcErrors.invalidParams);
        } else if (seen.has(parsed.data.turn)) {
          reply(id, {});
        } else if (current && current.phase !== "ended") {
          refuse(id, rpcErrors.busy);
        } else {
          reply(id, {});
          startTurn(session, parsed.data.turn, parsed.data.text);
        }
        return false;
      }
      case adapterMethods.turnCancel: {
        const parsed = turnCancelParams.safeParse(params);
        if (!parsed.success) {
          refuse(id, rpcErrors.invalidParams);
          return false;
        }
        if (current?.id === parsed.data.turn) cancel(current);
        reply(id, {});
        return false;
      }
      case adapterMethods.shutdown:
        await closeDown();
        reply(id, {});
        return true;
      default:
        refuse(id, rpcErrors.methodNotFound);
        return false;
    }
  };

  let shutDown = false;
  try {
    while (!broken) {
      const next = await read();
      if (next.done) break;
      const message = parseLine(next.value);
      if (!message) {
        io.log("the bot runner sent a line that isn't a JSON-RPC message");
        continue;
      }
      if ("method" in message) {
        if (
          "id" in message &&
          (typeof message.id === "string" || typeof message.id === "number") &&
          (await request(message.id, message.method, message.params))
        ) {
          shutDown = true;
          break;
        }
      }
    }
  } finally {
    interrupt = undefined;
    void input.return?.();
    if (!shutDown) await closeDown();
    await writing;
  }
  if (broken) throw broken.error;
}
