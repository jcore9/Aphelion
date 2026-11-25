import { describe, expect, test } from "vitest";
import {
  permissionRequest,
  sessionRef,
  toolCallId,
  turnId,
  type AdapterContext,
  type AdapterEvent,
} from "./adapter.ts";
import { fakeAdapter } from "./adapter-testing.ts";

const done: AdapterEvent = { type: "turn.end", reason: "completed" };

const context = (
  decide: AdapterContext["decide"] = () =>
    Promise.resolve({ decision: "allow", by: "rule", reason: "ok" }),
): AdapterContext => ({
  bot: { id: "b1" },
  folder: "/work",
  resume: null,
  decide,
  log: () => undefined,
});

const collect = async (stream: AsyncIterable<AdapterEvent>) => {
  const events: AdapterEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

describe("fakeAdapter", () => {
  test("yields each turn's events in order, one script entry per turn", async () => {
    const adapter = fakeAdapter([
      [{ emit: { type: "text.delta", text: "a" } }, { emit: done }],
      [{ emit: { type: "session", ref: sessionRef.parse("s1") } }],
    ]);
    const session = await adapter.open(context());
    const signal = new AbortController().signal;
    const first = await collect(
      session.turn({ turn: turnId.parse("t1"), text: "go" }, signal),
    );
    const second = await collect(
      session.turn({ turn: turnId.parse("t2"), text: "again" }, signal),
    );
    const third = await collect(
      session.turn({ turn: turnId.parse("t3"), text: "more" }, signal),
    );
    expect(first).toEqual([{ type: "text.delta", text: "a" }, done]);
    expect(second).toEqual([{ type: "session", ref: "s1" }]);
    expect(third).toEqual([]);
    expect(adapter.inputs.map(({ text }) => text)).toEqual([
      "go",
      "again",
      "more",
    ]);
  });

  test("keeps the answer to an ask step", async () => {
    const request = permissionRequest.parse({
      request: "r1",
      call: null,
      tool: "Bash",
      kind: "shell",
      paths: [],
      command: "ls",
      truncated: false,
    });
    const adapter = fakeAdapter([[{ ask: request }, { emit: done }]]);
    const session = await adapter.open(
      context(() =>
        Promise.resolve({ decision: "deny", by: "policy", reason: "no" }),
      ),
    );
    await collect(
      session.turn(
        { turn: turnId.parse("t1"), text: "go" },
        new AbortController().signal,
      ),
    );
    expect(adapter.answers).toEqual([
      { decision: "deny", by: "policy", reason: "no" },
    ]);
  });

  test("waitForAbort resumes when the signal aborts", async () => {
    const adapter = fakeAdapter([[{ waitForAbort: true }, { emit: done }]]);
    const session = await adapter.open(context());
    const controller = new AbortController();
    const running = collect(
      session.turn({ turn: turnId.parse("t1"), text: "go" }, controller.signal),
    );
    controller.abort();
    expect(await running).toEqual([done]);
  });

  test("wait holds the stream until the promise settles", async () => {
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const adapter = fakeAdapter([[{ wait: gate }, { emit: done }]]);
    const session = await adapter.open(context());
    const events: AdapterEvent[] = [];
    const running = (async () => {
      for await (const event of session.turn(
        { turn: turnId.parse("t1"), text: "go" },
        new AbortController().signal,
      ))
        events.push(event);
    })();
    await Promise.resolve();
    expect(events).toEqual([]);
    open();
    await running;
    expect(events).toEqual([done]);
  });

  test("throws steps reject, and close is recorded", async () => {
    const adapter = fakeAdapter([[{ throws: true }]]);
    const session = await adapter.open(context());
    await expect(
      collect(
        session.turn(
          { turn: turnId.parse("t1"), text: "go" },
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow("told to throw");
    expect(adapter.closed).toBe(false);
    await session.close?.();
    expect(adapter.closed).toBe(true);
  });

  test("yields a raw value as it is", async () => {
    const adapter = fakeAdapter([
      [{ emitRaw: { nope: toolCallId.parse("c") } }],
    ]);
    const session = await adapter.open(context());
    const events = await collect(
      session.turn(
        { turn: turnId.parse("t1"), text: "go" },
        new AbortController().signal,
      ),
    );
    expect(events).toEqual([{ nope: "c" }]);
  });
});
