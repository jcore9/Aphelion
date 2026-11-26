import { afterEach, describe, expect, test, vi } from "vitest";
import {
  adapterEvent,
  permissionRequest,
  type AdapterEvent,
  type AdapterSession,
  type BotAdapter,
  type Decider,
  type PermissionDecision,
  type TurnInput,
} from "./adapter.ts";
import { checkStream } from "./adapter-check.ts";
import {
  fakeAdapter,
  runTurn,
  startAdapter,
  type FakeStep,
} from "./adapter-testing.ts";
import { rpcErrors } from "./wire.ts";

const ev = (event: Record<string, unknown>): AdapterEvent =>
  adapterEvent.parse(event);
const emit = (event: Record<string, unknown>): FakeStep => ({
  emit: ev(event),
});
const done = (reason = "completed") => emit({ type: "turn.end", reason });
const text = (value: string) => emit({ type: "text.delta", text: value });
const toolStart = (call: string) =>
  emit({ type: "tool.start", call, tool: "Bash", kind: "shell" });
const toolEnd = (call: string, outcome = "ok") =>
  emit({ type: "tool.end", call, outcome });
const usage = emit({
  type: "usage",
  inputTokens: 3,
  outputTokens: 4,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.01,
});

const ask = (request: string, call: string | null = null): FakeStep => ({
  ask: permissionRequest.parse({
    request,
    call,
    tool: "Bash",
    kind: "shell",
    paths: ["/work/secret-path.txt"],
    command: "rm -rf secret-command",
    truncated: false,
  }),
});

const types = (events: readonly { event: { type: string } }[]) =>
  events.map(({ event }) => event.type);

const allow: PermissionDecision = {
  decision: "allow",
  by: "rule",
  reason: "inside-folder",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("a normal turn", () => {
  test("numbers every event, stamps the turn and passes checkStream", async () => {
    const adapter = fakeAdapter([
      [
        emit({ type: "session", ref: "s1" }),
        text("he"),
        toolStart("c1"),
        toolEnd("c1"),
        text("llo"),
        usage,
        done(),
      ],
    ]);
    const run = await runTurn(adapter, { text: "go" });
    expect(run.reply).toEqual({ result: {} });
    expect(run.problems).toEqual([]);
    expect(run.events.map(({ seq }) => seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(run.events.map(({ turn }) => turn)).toEqual([
      null,
      "t1",
      "t1",
      "t1",
      "t1",
      "t1",
      "t1",
    ]);
    expect(types(run.events)).toEqual([
      "session",
      "text.delta",
      "tool.start",
      "tool.end",
      "text.delta",
      "usage",
      "turn.end",
    ]);
    expect(checkStream(run.events)).toEqual([]);
    expect(adapter.inputs.map(({ text: prompt }) => prompt)).toEqual(["go"]);
    expect(adapter.closed).toBe(true);
  });

  test("a second turn continues the numbering", async () => {
    const harness = startAdapter(
      fakeAdapter([
        [text("a"), done()],
        [text("b"), done()],
      ]),
    );
    await harness.initialize();
    await harness.startTurn("t1", "one");
    await harness.untilEvent(({ turn }) => turn === "t1");
    await harness.untilEvent(({ event }) => event.type === "turn.end");
    await harness.startTurn("t2", "two");
    await harness.untilEvent(
      ({ turn, event }) => turn === "t2" && event.type === "turn.end",
    );
    await harness.shutdown();
    expect(harness.events.map(({ seq }) => seq)).toEqual([1, 2, 3, 4]);
    expect(checkStream(harness.events)).toEqual([]);
  });

  test("drops an empty text delta without a word", async () => {
    const run = await runTurn(
      fakeAdapter([
        [{ emitRaw: { type: "text.delta", text: "" } }, text("x"), done()],
      ]),
    );
    expect(types(run.events)).toEqual(["text.delta", "turn.end"]);
    expect(run.events[1]?.event).toEqual({
      type: "turn.end",
      reason: "completed",
    });
    expect(run.logs).toEqual([]);
  });

  test("keeps a session event from the middle of a turn at turn null", async () => {
    const run = await runTurn(
      fakeAdapter([[text("a"), emit({ type: "session", ref: "s2" }), done()]]),
    );
    expect(run.events.map(({ turn }) => turn)).toEqual(["t1", null, "t1"]);
    expect(checkStream(run.events)).toEqual([]);
  });
});

describe("initialize and requests", () => {
  test("replies with the API version and the provider, and passes what the runner sent", async () => {
    const adapter = fakeAdapter([], "claude");
    const harness = startAdapter(adapter);
    expect(await harness.initialize("resume-1")).toEqual({
      result: { api: "0.1.0", provider: "claude" },
    });
    const [context] = adapter.contexts;
    expect(context?.bot).toEqual({ id: "bot-1" });
    expect(context?.folder).toBe("/work");
    expect(context?.resume).toBe("resume-1");
    await harness.shutdown();
    await harness.done;
  });

  test("refuses turn.start before initialize, and a second initialize", async () => {
    const harness = startAdapter(fakeAdapter([[done()]]));
    expect(await harness.startTurn("t1", "x")).toEqual({
      error: rpcErrors.invalidRequest,
    });
    await harness.initialize();
    expect(await harness.initialize()).toEqual({
      error: rpcErrors.invalidRequest,
    });
    await harness.shutdown();
  });

  test("refuses bad params and unknown methods", async () => {
    const harness = startAdapter(fakeAdapter([[done()]]));
    await harness.initialize();
    expect(await harness.startTurn("not a turn id", "x")).toEqual({
      error: rpcErrors.invalidParams,
    });
    expect(await harness.cancel("not a turn id")).toEqual({
      error: rpcErrors.invalidParams,
    });
    await harness.shutdown();
  });

  test("rejects and answers operationFailed when open fails", async () => {
    const adapter: BotAdapter = {
      provider: "x",
      open: () => {
        throw new Error("no CLI");
      },
    };
    const harness = startAdapter(adapter);
    expect(await harness.initialize()).toEqual({
      error: rpcErrors.operationFailed,
    });
    await expect(harness.done).rejects.toThrow("no CLI");
    expect(harness.logs.join("\n")).toContain("open failed");
  });

  test("stops cleanly when the runner closes its input", async () => {
    const adapter = fakeAdapter([[{ hang: true }]]);
    const harness = startAdapter(adapter);
    await harness.initialize();
    await harness.startTurn("t1", "x");
    await harness.shutdown();
    await harness.done;
    expect(adapter.closed).toBe(true);
    expect(adapter.signals[0]?.aborted).toBe(true);
  });
});

describe("one turn at a time", () => {
  test("refuses a second turn with busy", async () => {
    const adapter = fakeAdapter([[{ hang: true }], [done()]]);
    const harness = startAdapter(adapter);
    await harness.initialize();
    expect(await harness.startTurn("t1", "a")).toEqual({ result: {} });
    expect(await harness.startTurn("t2", "b")).toEqual({
      error: rpcErrors.busy,
    });
    expect(adapter.inputs).toHaveLength(1);
    await harness.shutdown();
  });

  test("accepts a repeat of the running turn's own start without running it twice", async () => {
    const adapter = fakeAdapter([[{ hang: true }]]);
    const harness = startAdapter(adapter);
    await harness.initialize();
    expect(await harness.startTurn("t1", "a")).toEqual({ result: {} });
    expect(await harness.startTurn("t1", "a")).toEqual({ result: {} });
    expect(adapter.inputs).toHaveLength(1);
    await harness.shutdown();
  });

  test("refuses a repeat of a finished turn's start with turnEnded and still runs a new turn", async () => {
    const adapter = fakeAdapter([[done()], [done()]]);
    const harness = startAdapter(adapter);
    await harness.initialize();
    await harness.startTurn("t1", "a");
    await harness.untilEvent(({ event }) => event.type === "turn.end");
    expect(await harness.startTurn("t1", "a")).toEqual({
      error: rpcErrors.turnEnded,
    });
    expect(await harness.startTurn("t2", "b")).toEqual({ result: {} });
    await harness.untilEvent(
      ({ turn, event }) => turn === "t2" && event.type === "turn.end",
    );
    expect(adapter.inputs.map(({ text }) => text)).toEqual(["a", "b"]);
    expect(checkStream(harness.events)).toEqual([]);
    await harness.shutdown();
  });

  test("refuses a repeat of a finished turn with turnEnded, not busy, while another turn runs", async () => {
    const adapter = fakeAdapter([[done()], [{ hang: true }]]);
    const harness = startAdapter(adapter);
    await harness.initialize();
    await harness.startTurn("t1", "a");
    await harness.untilEvent(({ event }) => event.type === "turn.end");
    await harness.startTurn("t2", "b");
    expect(await harness.startTurn("t1", "a")).toEqual({
      error: rpcErrors.turnEnded,
    });
    expect(await harness.startTurn("t2", "b")).toEqual({ result: {} });
    expect(adapter.inputs).toHaveLength(2);
    await harness.shutdown();
  });

  test("accepts a new turn as soon as the last one ended", async () => {
    const harness = startAdapter(fakeAdapter([[done()], [done()]]));
    await harness.initialize();
    await harness.startTurn("t1", "a");
    await harness.untilEvent(({ event }) => event.type === "turn.end");
    expect(await harness.startTurn("t2", "b")).toEqual({ result: {} });
    await harness.shutdown();
  });
});

describe("a broken adapter ends the turn", () => {
  const expectErrorEnd = (
    events: ReturnType<typeof startAdapter>["events"],
  ) => {
    expect(events.slice(-2).map(({ event }) => event)).toEqual([
      { type: "error", code: "adapter" },
      { type: "turn.end", reason: "error" },
    ]);
    expect(checkStream(events)).toEqual([]);
  };

  test("a stream that throws", async () => {
    const run = await runTurn(fakeAdapter([[text("a"), { throws: true }]]));
    expectErrorEnd(run.events);
  });

  test("a stream that ends without turn.end", async () => {
    const run = await runTurn(fakeAdapter([[text("a")]]));
    expectErrorEnd(run.events);
  });

  test("an invalid event, and the adapter's signal aborts", async () => {
    const adapter = fakeAdapter([
      [
        text("a"),
        { emitRaw: { type: "tool.start", call: "c1" } },
        text("never"),
      ],
    ]);
    const run = await runTurn(adapter);
    expect(types(run.events)).toEqual(["text.delta", "error", "turn.end"]);
    expectErrorEnd(run.events);
    expect(adapter.signals[0]?.aborted).toBe(true);
  });

  test("an event with a field that isn't allowed", async () => {
    const run = await runTurn(
      fakeAdapter([
        [{ emitRaw: { type: "error", code: "vendor", message: "x" } }],
      ]),
    );
    expectErrorEnd(run.events);
  });

  test.each([
    [
      "a permission.request",
      {
        type: "permission.request",
        request: "r1",
        call: null,
        tool: "Bash",
        kind: "shell",
        pathCount: 0,
        hasCommand: true,
      },
    ],
    [
      "a permission.decision",
      {
        type: "permission.decision",
        request: "r1",
        decision: "allow",
        by: "rule",
        reason: "x",
      },
    ],
  ])("%s that the adapter yields itself", async (_name, event) => {
    const run = await runTurn(fakeAdapter([[{ emitRaw: event }]]));
    expectErrorEnd(run.events);
    expect(types(run.events)).not.toContain("permission.request");
  });

  test("two usage events", async () => {
    const run = await runTurn(fakeAdapter([[usage, usage, done()]]));
    expect(types(run.events)).toEqual(["usage", "error", "turn.end"]);
  });

  test("a tool.end for a call that never started", async () => {
    const run = await runTurn(fakeAdapter([[toolEnd("c9"), done()]]));
    expect(types(run.events)).toEqual(["error", "turn.end"]);
  });

  test("the same call ended twice", async () => {
    const run = await runTurn(
      fakeAdapter([[toolStart("c1"), toolEnd("c1"), toolEnd("c1"), done()]]),
    );
    expect(types(run.events)).toEqual([
      "tool.start",
      "tool.end",
      "error",
      "turn.end",
    ]);
  });

  test("the same call started twice", async () => {
    const run = await runTurn(
      fakeAdapter([[toolStart("c1"), toolStart("c1"), done()]]),
    );
    expect(types(run.events)).toEqual(["tool.start", "error", "turn.end"]);
  });

  test("the runtime never invents a tool.end for a call the turn left open", async () => {
    const run = await runTurn(
      fakeAdapter([[toolStart("c1"), { throws: true }]]),
    );
    expect(types(run.events)).toEqual(["tool.start", "error", "turn.end"]);
  });
});

describe("a call that outlives its turn", () => {
  test("a tool.end after turn.end keeps the starting turn's id", async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const harness = startAdapter(
      fakeAdapter([
        [toolStart("bg"), done(), { wait: gate }, toolEnd("bg"), text("late")],
        [text("next"), done()],
      ]),
    );
    await harness.initialize();
    await harness.startTurn("t1", "start it");
    await harness.untilEvent(({ event }) => event.type === "turn.end");
    expect(types(harness.events)).toEqual(["tool.start", "turn.end"]);
    await harness.startTurn("t2", "next");
    await harness.untilEvent(
      ({ turn, event }) => turn === "t2" && event.type === "turn.end",
    );
    open();
    await harness.untilEvent(({ event }) => event.type === "tool.end");
    await harness.shutdown();
    const last = harness.events.at(-1);
    expect(last?.turn).toBe("t1");
    expect(last?.event.type).toBe("tool.end");
    expect(types(harness.events)).not.toContain("error");
    expect(checkStream(harness.events)).toEqual([]);
    expect(harness.logs.join("\n")).toContain("after its turn ended");
  });
});

describe("permission requests", () => {
  const request = (events: readonly { event: unknown }[]) =>
    JSON.stringify(events);

  test("denyAll answers deny by default, and the events carry no path or command", async () => {
    const adapter = fakeAdapter([
      [
        toolStart("c1"),
        ask("r1", "c1"),
        toolEnd("c1", "denied"),
        done("denied"),
      ],
    ]);
    const run = await runTurn(adapter);
    expect(adapter.answers).toEqual([
      { decision: "deny", by: "default", reason: "no-decider" },
    ]);
    const asked = run.events.find(
      ({ event }) => event.type === "permission.request",
    );
    expect(asked?.event).toEqual({
      type: "permission.request",
      request: "r1",
      call: "c1",
      tool: "Bash",
      kind: "shell",
      pathCount: 1,
      hasCommand: true,
    });
    expect(request(run.events)).not.toContain("secret-path");
    expect(request(run.events)).not.toContain("secret-command");
    expect(types(run.events)).toEqual([
      "tool.start",
      "permission.request",
      "permission.decision",
      "tool.end",
      "turn.end",
    ]);
    expect(checkStream(run.events)).toEqual([]);
  });

  test("a decider's allow reaches the adapter and the stream", async () => {
    const seen: string[] = [];
    const decider: Decider = (asked) => {
      seen.push(
        `${asked.kind} ${asked.paths.join(",")} ${asked.command ?? ""}`,
      );
      return allow;
    };
    const adapter = fakeAdapter([[ask("r1"), done()]]);
    const run = await runTurn(adapter, { decider });
    expect(seen).toEqual(["shell /work/secret-path.txt rm -rf secret-command"]);
    expect(adapter.answers).toEqual([allow]);
    expect(
      run.events.find(({ event }) => event.type === "permission.decision")
        ?.event,
    ).toEqual({
      type: "permission.decision",
      request: "r1",
      ...allow,
    });
    expect(checkStream(run.events)).toEqual([]);
  });

  test("an invalid request is denied without an event", async () => {
    const adapter = fakeAdapter([[{ hang: true }]]);
    const harness = startAdapter(adapter);
    await harness.initialize();
    await harness.startTurn("t1", "x");
    const answer = await adapter.inputs[0]?.decide({
      request: "r1",
    } as never);
    expect(answer).toEqual({
      decision: "deny",
      by: "default",
      reason: "invalid-request",
    });
    expect(harness.events).toEqual([]);
    await harness.shutdown();
  });

  test("a decider that throws, or answers badly, is denied", async () => {
    const throwing = await runTurn(fakeAdapter([[ask("r1"), done()]]), {
      decider: () => {
        throw new Error("boom");
      },
    });
    const nonsense = await runTurn(fakeAdapter([[ask("r1"), done()]]), {
      decider: () =>
        ({ decision: "allow", by: "me", reason: "Has Spaces" }) as never,
    });
    for (const [run, reason] of [
      [throwing, "decider-failed"],
      [nonsense, "invalid-decision"],
    ] as const) {
      expect(
        run.events.find(({ event }) => event.type === "permission.decision")
          ?.event,
      ).toMatchObject({
        decision: "deny",
        by: "default",
        reason,
      });
      expect(checkStream(run.events)).toEqual([]);
    }
  });

  test("a request id used twice in a turn is denied without a second event", async () => {
    const run = await runTurn(fakeAdapter([[ask("r1"), ask("r1"), done()]]), {
      decider: () => allow,
    });
    expect(types(run.events)).toEqual([
      "permission.request",
      "permission.decision",
      "turn.end",
    ]);
  });

  test("a request that comes after the turn ended is denied without an event", async () => {
    const adapter = fakeAdapter([[done()]]);
    const harness = startAdapter(adapter, { decider: () => allow });
    await harness.initialize();
    await harness.startTurn("t1", "x");
    await harness.untilEvent(({ event }) => event.type === "turn.end");
    const answer = await adapter.inputs[0]?.decide(
      permissionRequest.parse({
        request: "late",
        call: null,
        tool: "Bash",
        kind: "shell",
        paths: [],
        command: null,
        truncated: false,
      }),
    );
    expect(answer).toEqual({
      decision: "deny",
      by: "default",
      reason: "turn-ended",
    });
    await harness.shutdown();
    expect(types(harness.events)).toEqual(["turn.end"]);
  });

  test("a request for a call that an earlier turn started is denied without an event", async () => {
    const adapter = fakeAdapter([[toolStart("bg"), done()], [{ hang: true }]]);
    const harness = startAdapter(adapter, { decider: () => allow });
    await harness.initialize();
    await harness.startTurn("t1", "x");
    await harness.untilEvent(({ event }) => event.type === "turn.end");
    await harness.startTurn("t2", "y");
    const answer = await adapter.inputs[1]?.decide(
      permissionRequest.parse({
        request: "r1",
        call: "bg",
        tool: "Bash",
        kind: "shell",
        paths: [],
        command: null,
        truncated: false,
      }),
    );
    expect(answer?.reason).toBe("turn-ended");
    await harness.shutdown();
    expect(types(harness.events)).not.toContain("permission.request");
  });

  test("a request still open when the turn ends is settled before turn.end", async () => {
    const adapter: BotAdapter = {
      provider: "x",
      open: (): AdapterSession => ({
        async *turn({ decide }) {
          const pending = decide(
            permissionRequest.parse({
              request: "r1",
              call: null,
              tool: "Bash",
              kind: "shell",
              paths: [],
              command: null,
              truncated: false,
            }),
          );
          yield ev({ type: "turn.end", reason: "completed" });
          answers.push(await pending);
        },
      }),
    };
    const answers: PermissionDecision[] = [];
    const run = await runTurn(adapter, {
      decider: () => new Promise(() => undefined),
    });
    expect(types(run.events)).toEqual([
      "permission.request",
      "permission.decision",
      "turn.end",
    ]);
    expect(run.events[1]?.event).toMatchObject({
      decision: "deny",
      by: "default",
      reason: "turn-ended",
    });
    expect(checkStream(run.events)).toEqual([]);
    await Promise.resolve();
    expect(answers).toEqual([
      { decision: "deny", by: "default", reason: "turn-ended" },
    ]);
  });

  test("a decider that is too slow is denied at the deadline", async () => {
    vi.useFakeTimers();
    const adapter = fakeAdapter([[ask("r1"), done()]]);
    const harness = startAdapter(adapter, {
      decider: () => new Promise(() => undefined),
      decisionDeadlineMs: 30_000,
    });
    await harness.initialize();
    await harness.startTurn("t1", "x");
    await harness.untilEvent(
      ({ event }) => event.type === "permission.request",
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(types(harness.events)).toEqual(["permission.request"]);
    await vi.advanceTimersByTimeAsync(1);
    await harness.untilEvent(({ event }) => event.type === "turn.end");
    expect(harness.events[1]?.event).toMatchObject({
      decision: "deny",
      reason: "timeout",
    });
    expect(checkStream(harness.events)).toEqual([]);
    await harness.shutdown();
  });

  test("an answer before the deadline stops the timer", async () => {
    vi.useFakeTimers();
    const adapter = fakeAdapter([[ask("r1"), done()]]);
    const harness = startAdapter(adapter, {
      decider: () => allow,
      decisionDeadlineMs: 1000,
    });
    await harness.initialize();
    await harness.startTurn("t1", "x");
    await harness.untilEvent(({ event }) => event.type === "turn.end");
    await vi.advanceTimersByTimeAsync(5000);
    expect(types(harness.events)).toEqual([
      "permission.request",
      "permission.decision",
      "turn.end",
    ]);
    await harness.shutdown();
  });
});

describe("cancel", () => {
  test("a cancel that the adapter honors ends with the adapter's own turn.end", async () => {
    const adapter = fakeAdapter([
      [text("a"), { waitForAbort: true }, done("cancelled")],
    ]);
    const harness = startAdapter(adapter);
    await harness.initialize();
    await harness.startTurn("t1", "x");
    await harness.untilEvent(({ event }) => event.type === "text.delta");
    expect(await harness.cancel("t1")).toEqual({ result: {} });
    await harness.untilEvent(({ event }) => event.type === "turn.end");
    expect(harness.events.at(-1)?.event).toEqual({
      type: "turn.end",
      reason: "cancelled",
    });
    expect(adapter.signals[0]?.aborted).toBe(true);
    expect(checkStream(harness.events)).toEqual([]);
    await harness.shutdown();
  });

  test("a stream that just ends after a cancel counts as cancelled, not as an error", async () => {
    const harness = startAdapter(fakeAdapter([[{ waitForAbort: true }]]));
    await harness.initialize();
    await harness.startTurn("t1", "x");
    await harness.cancel("t1");
    await harness.untilEvent(({ event }) => event.type === "turn.end");
    expect(types(harness.events)).toEqual(["turn.end"]);
    expect(harness.events[0]?.event).toEqual({
      type: "turn.end",
      reason: "cancelled",
    });
    await harness.shutdown();
  });

  test("a cancel that the adapter ignores ends after 5 seconds, and the next turn can start", async () => {
    vi.useFakeTimers();
    const adapter = fakeAdapter([[toolStart("c1"), { hang: true }], [done()]]);
    const harness = startAdapter(adapter);
    await harness.initialize();
    await harness.startTurn("t1", "x");
    await harness.untilEvent(({ event }) => event.type === "tool.start");
    await harness.cancel("t1");
    await vi.advanceTimersByTimeAsync(4999);
    expect(types(harness.events)).toEqual(["tool.start"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(types(harness.events)).toEqual(["tool.start", "turn.end"]);
    expect(harness.events[1]?.event).toEqual({
      type: "turn.end",
      reason: "cancelled",
    });
    expect(await harness.startTurn("t2", "again")).toEqual({ result: {} });
    await harness.shutdown();
  });

  test("a stream that wakes up late after the runtime ended the turn loses everything but tool.end", async () => {
    vi.useFakeTimers();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const adapter = fakeAdapter([
      [toolStart("c1"), { wait: gate }, text("dropped"), toolEnd("c1"), done()],
    ]);
    const harness = startAdapter(adapter);
    await harness.initialize();
    await harness.startTurn("t1", "x");
    await harness.untilEvent(({ event }) => event.type === "tool.start");
    await harness.cancel("t1");
    await vi.advanceTimersByTimeAsync(5000);
    open();
    await vi.advanceTimersByTimeAsync(0);
    await harness.untilEvent(({ event }) => event.type === "tool.end");
    expect(types(harness.events)).toEqual([
      "tool.start",
      "turn.end",
      "tool.end",
    ]);
    expect(checkStream(harness.events)).toEqual([]);
    await harness.shutdown();
  });

  test("a cancel for another turn, or when idle, changes nothing", async () => {
    const adapter = fakeAdapter([[{ hang: true }]]);
    const harness = startAdapter(adapter);
    await harness.initialize();
    expect(await harness.cancel("t1")).toEqual({ result: {} });
    await harness.startTurn("t1", "x");
    expect(await harness.cancel("other")).toEqual({ result: {} });
    expect(adapter.signals[0]?.aborted).toBe(false);
    await harness.shutdown();
  });

  test("a cancel while decide waits settles the ask as deny before turn.end, and a late allow is ignored", async () => {
    let answer: (decision: PermissionDecision) => void = () => undefined;
    const decider: Decider = () =>
      new Promise<PermissionDecision>((resolve) => {
        answer = resolve;
      });
    const adapter = fakeAdapter([
      [
        toolStart("c1"),
        ask("r1", "c1"),
        toolEnd("c1", "denied"),
        done("cancelled"),
      ],
    ]);
    const harness = startAdapter(adapter, { decider });
    await harness.initialize();
    await harness.startTurn("t1", "x");
    await harness.untilEvent(
      ({ event }) => event.type === "permission.request",
    );
    await harness.cancel("t1");
    await harness.untilEvent(({ event }) => event.type === "turn.end");
    answer(allow);
    await Promise.resolve();
    expect(types(harness.events)).toEqual([
      "tool.start",
      "permission.request",
      "permission.decision",
      "tool.end",
      "turn.end",
    ]);
    expect(harness.events[2]?.event).toEqual({
      type: "permission.decision",
      request: "r1",
      decision: "deny",
      by: "default",
      reason: "cancelled",
    });
    expect(adapter.answers).toEqual([
      { decision: "deny", by: "default", reason: "cancelled" },
    ]);
    expect(checkStream(harness.events)).toEqual([]);
    await harness.shutdown();
  });

  test("a request after the cancel is denied without an event", async () => {
    const adapter = fakeAdapter([
      [{ waitForAbort: true }, ask("r1"), done("cancelled")],
    ]);
    const harness = startAdapter(adapter, { decider: () => allow });
    await harness.initialize();
    await harness.startTurn("t1", "x");
    await harness.cancel("t1");
    await harness.untilEvent(({ event }) => event.type === "turn.end");
    expect(types(harness.events)).toEqual(["turn.end"]);
    expect(adapter.answers[0]).toMatchObject({
      decision: "deny",
      reason: "cancelled",
    });
    await harness.shutdown();
  });
});

describe("an ask is bound to its own turn", () => {
  test("a stale turn that asks after the runtime ended it gets deny, and the next turn's stream is untouched", async () => {
    vi.useFakeTimers();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const adapter = fakeAdapter([
      [{ wait: gate }, ask("stale"), text("dropped"), done("cancelled")],
      [{ hang: true }],
    ]);
    const harness = startAdapter(adapter, { decider: () => allow });
    await harness.initialize();
    await harness.startTurn("t1", "x");
    await harness.cancel("t1");
    await vi.advanceTimersByTimeAsync(5000);
    expect(await harness.startTurn("t2", "y")).toEqual({ result: {} });
    open();
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.answers).toEqual([
      { decision: "deny", by: "default", reason: "turn-ended" },
    ]);
    expect(types(harness.events)).toEqual(["turn.end"]);
    expect(harness.events.every(({ turn }) => turn !== "t2")).toBe(true);
    await harness.shutdown();
  });

  test("a turn's own decide still reaches the decider while it runs", async () => {
    const adapter = fakeAdapter([
      [ask("r1"), done()],
      [ask("r2"), done()],
    ]);
    const harness = startAdapter(adapter, { decider: () => allow });
    await harness.initialize();
    await harness.startTurn("t1", "x");
    await harness.untilEvent(({ event }) => event.type === "turn.end");
    await harness.startTurn("t2", "y");
    await harness.untilEvent(
      ({ turn, event }) => turn === "t2" && event.type === "turn.end",
    );
    expect(adapter.answers).toEqual([allow, allow]);
    expect(
      harness.events
        .filter(({ event }) => event.type === "permission.request")
        .map(({ turn }) => turn),
    ).toEqual(["t1", "t2"]);
    expect(checkStream(harness.events)).toEqual([]);
    await harness.shutdown();
  });
});

describe("shutdown", () => {
  test("flushes an open ask and ends an open turn as cancelled", async () => {
    const adapter = fakeAdapter([
      [toolStart("c1"), ask("r1", "c1"), toolEnd("c1", "denied"), done()],
    ]);
    const harness = startAdapter(adapter, {
      decider: () => new Promise(() => undefined),
    });
    await harness.initialize();
    await harness.startTurn("t1", "x");
    await harness.untilEvent(
      ({ event }) => event.type === "permission.request",
    );
    await harness.shutdown();
    await harness.done;
    expect(types(harness.events)).toEqual([
      "tool.start",
      "permission.request",
      "permission.decision",
      "turn.end",
    ]);
    expect(harness.events[2]?.event).toMatchObject({
      decision: "deny",
      by: "default",
      reason: "shutdown",
    });
    expect(harness.events[3]?.event).toEqual({
      type: "turn.end",
      reason: "cancelled",
    });
    expect(adapter.answers).toEqual([
      { decision: "deny", by: "default", reason: "shutdown" },
    ]);
    expect(checkStream(harness.events)).toEqual([]);
  });

  test("a running turn without asks ends as cancelled", async () => {
    const harness = startAdapter(fakeAdapter([[text("a"), { hang: true }]]));
    await harness.initialize();
    await harness.startTurn("t1", "x");
    await harness.untilEvent(({ event }) => event.type === "text.delta");
    await harness.shutdown();
    await harness.done;
    expect(types(harness.events)).toEqual(["text.delta", "turn.end"]);
    expect(checkStream(harness.events)).toEqual([]);
  });

  test("an idle shutdown sends no event", async () => {
    const harness = startAdapter(fakeAdapter([[done()]]));
    await harness.initialize();
    await harness.startTurn("t1", "x");
    await harness.untilEvent(({ event }) => event.type === "turn.end");
    await harness.shutdown();
    await harness.done;
    expect(types(harness.events)).toEqual(["turn.end"]);
  });

  test("an ask made from close() is denied at once with no event", async () => {
    let decide: TurnInput["decide"] | undefined;
    const answers: PermissionDecision[] = [];
    const adapter: BotAdapter = {
      provider: "x",
      open: (): AdapterSession => ({
        async *turn(input) {
          decide = input.decide;
          yield ev({ type: "text.delta", text: "a" });
          await new Promise(() => undefined);
        },
        async close() {
          answers.push(
            await (decide as TurnInput["decide"])(
              permissionRequest.parse({
                request: "r9",
                call: null,
                tool: "Bash",
                kind: "shell",
                paths: [],
                command: null,
                truncated: false,
              }),
            ),
          );
        },
      }),
    };
    const harness = startAdapter(adapter, { decider: () => allow });
    await harness.initialize();
    await harness.startTurn("t1", "x");
    await harness.untilEvent(({ event }) => event.type === "text.delta");
    await harness.shutdown();
    await harness.done;
    expect(answers).toEqual([
      { decision: "deny", by: "default", reason: "shutdown" },
    ]);
    expect(types(harness.events)).toEqual(["text.delta", "turn.end"]);
    expect(checkStream(harness.events)).toEqual([]);
  });
});

describe("a denied tool.end needs a deny decision", () => {
  const denied = (...steps: FakeStep[]) => [
    toolStart("c1"),
    ...steps,
    toolEnd("c1", "denied"),
    done(),
  ];

  test("a denied end with no deny ends the turn with an adapter error", async () => {
    const run = await runTurn(fakeAdapter([denied()]));
    expect(types(run.events)).toEqual(["tool.start", "error", "turn.end"]);
    expect(checkStream(run.events)).toEqual([]);
  });

  test("a deny for that call, or a deny with call null, lets it through", async () => {
    for (const call of ["c1", null]) {
      const run = await runTurn(fakeAdapter([denied(ask("r1", call))]));
      expect(types(run.events)).toContain("tool.end");
      expect(types(run.events)).not.toContain("error");
      expect(checkStream(run.events)).toEqual([]);
    }
  });

  test("a deny for another call, or an allow, doesn't count", async () => {
    const other = await runTurn(
      fakeAdapter([[toolStart("c2"), ...denied(ask("r1", "c2"))]]),
    );
    expect(types(other.events)).toContain("error");
    const allowed = await runTurn(fakeAdapter([denied(ask("r1", "c1"))]), {
      decider: () => allow,
    });
    expect(types(allowed.events)).toContain("error");
  });

  test("a late denied end for a call started in an earlier turn needs that turn's deny", async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const harness = startAdapter(
      fakeAdapter([
        [toolStart("bg"), done(), { wait: gate }, toolEnd("bg", "denied")],
        [{ hang: true }],
      ]),
    );
    await harness.initialize();
    await harness.startTurn("t1", "x");
    await harness.untilEvent(({ event }) => event.type === "turn.end");
    await harness.startTurn("t2", "y");
    open();
    await Promise.resolve();
    await harness.shutdown();
    expect(types(harness.events)).not.toContain("tool.end");
    expect(harness.logs.join("\n")).toContain("after its turn ended");
  });

  test("a late denied end passes when the starting turn denied that call", async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const harness = startAdapter(
      fakeAdapter([
        [
          toolStart("bg"),
          ask("r1", "bg"),
          done(),
          { wait: gate },
          toolEnd("bg", "denied"),
        ],
        [{ hang: true }],
      ]),
    );
    await harness.initialize();
    await harness.startTurn("t1", "x");
    await harness.untilEvent(({ event }) => event.type === "turn.end");
    await harness.startTurn("t2", "y");
    open();
    await harness.untilEvent(({ event }) => event.type === "tool.end");
    expect(harness.events.at(-1)?.turn).toBe("t1");
    await harness.shutdown();
    await harness.done;
    expect(checkStream(harness.events)).toEqual([]);
  });
});

describe("every fake script passes checkStream", () => {
  const scripts: [string, FakeStep[][]][] = [
    ["a text turn", [[text("a"), done()]]],
    ["a tool turn", [[toolStart("c1"), toolEnd("c1"), done()]]],
    [
      "a denied tool",
      [
        [
          toolStart("c1"),
          ask("r1", "c1"),
          toolEnd("c1", "denied"),
          done("denied"),
        ],
      ],
    ],
    [
      "a vendor error",
      [[emit({ type: "error", code: "signed-out" }), done("error")]],
    ],
    ["an empty script", [[]]],
    ["a throwing script", [[{ throws: true }]]],
  ];
  test.each(scripts)("%s", async (_name, script) => {
    const run = await runTurn(fakeAdapter(script));
    expect(run.problems).toEqual([]);
    expect(checkStream(run.events)).toEqual([]);
  });
});
