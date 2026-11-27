import {
  permissionRequest,
  sessionRef,
  toolCallId,
} from "@aphelion/plugin-sdk";
import type { FakeScript } from "@aphelion/plugin-sdk/testing";
import { streamId, type Cursor } from "@aphelion/protocol";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, test } from "vitest";
import {
  backoff,
  runChat,
  type ChatOptions,
  type SocketEvents,
} from "./session";
import { enroll, revoke, startServer, tempDb } from "./test-server";
import { connectWebSocket } from "./socket";
import { testHost, waitFor, type TestHost } from "./test-host";

const greeting =
  "Connected to chief. Type a message and press Enter. Ctrl-C cancels the turn, Ctrl-D leaves.\n";

const everything: FakeScript[number] = [
  { emit: { type: "session", ref: sessionRef.parse("vendor-secret-ref") } },
  { emit: { type: "text.delta", text: "Let me look. " } },
  {
    emit: {
      type: "tool.start",
      call: toolCallId.parse("c1"),
      tool: "Read",
      kind: "file.read",
    },
  },
  {
    ask: permissionRequest.parse({
      request: "r1",
      call: "c1",
      tool: "Read",
      kind: "file.read",
      paths: ["/secret/path"],
      command: null,
      truncated: false,
    }),
  },
  {
    emit: { type: "tool.end", call: toolCallId.parse("c1"), outcome: "ok" },
  },
  { emit: { type: "text.delta", text: "All done.\u001b[2J" } },
  {
    emit: {
      type: "usage",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      costUsd: null,
    },
  },
  { emit: { type: "error", code: "vendor" } },
  { emit: { type: "turn.end", reason: "completed" } },
];

const finishes = (text: string): FakeScript[number] => [
  { emit: { type: "text.delta", text } },
  { emit: { type: "turn.end", reason: "completed" } },
];

const hangs: FakeScript[number] = [
  { emit: { type: "text.delta", text: "working" } },
  { waitForAbort: true },
];

const chat = (
  host: TestHost,
  url: string,
  token: string,
  extra: Partial<ChatOptions> = {},
) => {
  const saved: Cursor[] = [];
  const done = runChat(
    {
      bot: "chief",
      url: `${url.replace(/^http/, "ws")}/ws`,
      token,
      cursor: null,
      saveCursor: (cursor) => saved.push(cursor),
      ...extra,
    },
    host,
  );
  return { done, saved };
};

describe("backoff", () => {
  test("starts at 250 ms, doubles to 5 s and jitters by 20 percent", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => backoff(n, () => 0.5))).toEqual([
      250, 500, 1000, 2000, 4000, 5000, 5000,
    ]);
    expect(backoff(2, () => 0)).toBe(800);
    expect(backoff(2, () => 1)).toBe(1200);
    expect(backoff(9, () => 1)).toBe(6000);
  });
});

describe("a chat against the real server", () => {
  it.live("shows every kind of event and nothing the bot's vendor keeps", () =>
    Effect.gen(function* () {
      const path = tempDb();
      const { token } = enroll(path);
      const server = yield* startServer(path, [everything]);
      const host = testHost();
      const { done } = chat(host, server.url, token);

      host.type("hello");
      host.endInput();
      const code = yield* Effect.promise(() => done);

      expect(code).toBe(0);
      expect(host.stdout()).toBe(
        `${greeting}Let me look. \n[tool] start Read (file.read)\n[permission] Read asks (file.read, paths: 1, command: no)\n[permission] deny by default (no-decider)\n[tool] end Read: ok\nAll done.[2J\n[usage] in=10 out=20 cache=3/4\n[turn] completed\n`,
      );
      expect(host.stderr()).toEqual([
        "[error] the AI tool's vendor reported an error",
      ]);
      expect(host.everything()).not.toContain("vendor-secret-ref");
      expect(host.everything()).not.toContain("/secret/path");
      expect(host.everything()).not.toContain(token);
      yield* server.stop;
    }),
  );

  it.live("shows what a dropped connection missed, once", () =>
    Effect.gen(function* () {
      const path = tempDb();
      const { token } = enroll(path);
      const gate = Promise.withResolvers<undefined>();
      const server = yield* startServer(path, [
        [
          { emit: { type: "text.delta", text: "one " } },
          { wait: gate.promise },
          { emit: { type: "text.delta", text: "two" } },
          { emit: { type: "turn.end", reason: "completed" } },
        ],
      ]);
      let down = false;
      const host = testHost((url, bearer, events) =>
        down
          ? Promise.reject(new Error("the server is unreachable"))
          : connectWebSocket(url, bearer, events),
      );
      const { done, saved } = chat(host, server.url, token);

      host.type("hello");
      yield* Effect.promise(() =>
        waitFor("the first text", () => host.stdout().includes("one ")),
      );
      down = true;
      host.drop();
      yield* Effect.promise(() =>
        waitFor("the drop to show", () => host.stderr().length > 0),
      );
      const before = server.history.head();
      gate.resolve(undefined);
      yield* Effect.promise(() =>
        waitFor(
          "the server to save the rest",
          () => server.history.head() >= before + 2,
        ),
      );
      expect(host.stdout()).not.toContain("two");
      down = false;
      yield* Effect.promise(() =>
        waitFor("the turn to end", () =>
          host.stdout().includes("[turn] completed"),
        ),
      );
      host.endInput();
      const code = yield* Effect.promise(() => done);

      expect(code).toBe(0);
      expect(host.stdout()).toBe(`${greeting}one \ntwo\n[turn] completed\n`);
      expect(host.stderr()).toEqual([
        "aphelion: lost the connection to the server, trying again",
        "aphelion: connected again",
      ]);
      expect(saved.at(-1)?.seq).toBe(server.history.head());
      yield* server.stop;
    }),
  );

  it.live(
    "sends a prompt again with the same ID after a drop, and the bot runs one turn",
    () =>
      Effect.gen(function* () {
        const path = tempDb();
        const { token } = enroll(path);
        const server = yield* startServer(path, [finishes("answer")]);
        const host = testHost();
        const { done } = chat(host, server.url, token);
        yield* Effect.promise(() =>
          waitFor("the greeting", () => host.stdout().includes("Connected")),
        );

        host.muteCurrent();
        host.type("hello");
        host.endInput();
        yield* Effect.promise(() =>
          waitFor(
            "the server to start the turn",
            () => server.turnsStarted() === 1,
          ),
        );
        host.drop();
        const code = yield* Effect.promise(() => done);

        const prompts = host
          .sent()
          .filter((frame) => frame["name"] === "bot.prompt");
        expect(code).toBe(0);
        expect(prompts).toHaveLength(2);
        expect(prompts[1]?.["id"]).toBe(prompts[0]?.["id"]);
        expect(host.stdout()).toBe(`${greeting}answer\n[turn] completed\n`);
        expect(server.turnsStarted()).toBe(1);
        yield* server.stop;
      }),
  );

  it.live(
    "carries on over a server restart on the same database, and sends a prompt typed while it was down",
    () =>
      Effect.gen(function* () {
        const path = tempDb();
        const { token } = enroll(path);
        const first = yield* startServer(path, [finishes("first")]);
        let down = false;
        const host = testHost((url, bearer, events) =>
          down
            ? Promise.reject(new Error("the server is down"))
            : connectWebSocket(url, bearer, events),
        );
        const { done } = chat(host, first.url, token);
        host.type("one");
        yield* Effect.promise(() =>
          waitFor("the first answer", () =>
            host.stdout().includes("[turn] completed"),
          ),
        );
        down = true;
        host.drop();
        yield* first.stop;
        yield* Effect.promise(() =>
          waitFor("the drop to show", () => host.stderr().length > 0),
        );
        host.type("two");

        const second = yield* startServer(path, [finishes("second")], {
          port: first.port,
        });
        down = false;
        yield* Effect.promise(() =>
          waitFor("the second answer", () => host.stdout().includes("second")),
        );
        host.endInput();
        const code = yield* Effect.promise(() => done);

        expect(code).toBe(0);
        expect(host.stdout()).toBe(
          `${greeting}first\n[turn] completed\nsecond\n[turn] completed\n`,
        );
        expect(host.stdout()).not.toContain("[notice]");
        expect(second.turnsStarted()).toBe(1);
        yield* second.stop;
      }),
  );

  it.live(
    "cancels the turn on the first Ctrl-C, shows how it ended, and leaves on the next",
    () =>
      Effect.gen(function* () {
        const path = tempDb();
        const { token } = enroll(path);
        const server = yield* startServer(path, [hangs]);
        const host = testHost();
        const { done } = chat(host, server.url, token);

        host.type("go");
        yield* Effect.promise(() =>
          waitFor("the bot to start", () => host.stdout().includes("working")),
        );
        host.interrupt();
        yield* Effect.promise(() =>
          waitFor("the turn to end", () =>
            host.stdout().includes("[turn] cancelled"),
          ),
        );
        host.interrupt();
        const code = yield* Effect.promise(() => done);

        const cancels = host
          .sent()
          .filter((frame) => frame["name"] === "bot.cancel");
        expect(code).toBe(0);
        expect(cancels).toHaveLength(1);
        expect(cancels[0]?.["payload"]).toMatchObject({ bot: "chief" });
        expect(cancels[0]?.["id"]).not.toBe(
          host.sent().find((frame) => frame["name"] === "bot.prompt")?.["id"],
        );
        yield* server.stop;
      }),
  );

  it.live("leaves at once on Ctrl-C when no turn is running", () =>
    Effect.gen(function* () {
      const path = tempDb();
      const { token } = enroll(path);
      const server = yield* startServer(path, [finishes("x")]);
      const host = testHost();
      const { done } = chat(host, server.url, token);
      yield* Effect.promise(() =>
        waitFor("the greeting", () => host.stdout().includes("Connected")),
      );

      host.interrupt();

      expect(yield* Effect.promise(() => done)).toBe(0);
      yield* server.stop;
    }),
  );

  it.live("exits 1 without retrying when the token is refused", () =>
    Effect.gen(function* () {
      const path = tempDb();
      const device = enroll(path);
      revoke(path, device.id);
      const server = yield* startServer(path, [finishes("x")]);
      const host = testHost();
      const { done } = chat(host, server.url, device.token);

      const code = yield* Effect.promise(() => done);

      expect(code).toBe(1);
      expect(host.connects()).toBe(1);
      expect(host.stderr()).toEqual([
        "aphelion: the device token was refused; add a device again with sudo aphelion device add",
      ]);
      expect(host.everything()).not.toContain(device.token);
      yield* server.stop;
    }),
  );

  it.live("exits 1 when the token is revoked during a chat", () =>
    Effect.gen(function* () {
      const path = tempDb();
      const device = enroll(path);
      const server = yield* startServer(path, [finishes("x")], {
        recheckMillis: 50,
      });
      const host = testHost();
      const { done } = chat(host, server.url, device.token);
      yield* Effect.promise(() =>
        waitFor("the greeting", () => host.stdout().includes("Connected")),
      );

      revoke(path, device.id);
      const code = yield* Effect.promise(() => done);

      expect(code).toBe(1);
      expect(host.connects()).toBe(1);
      expect(host.stderr().at(-1)).toContain("the device token was refused");
      yield* server.stop;
    }),
  );

  it.live("tells the owner when the server's history was restored", () =>
    Effect.gen(function* () {
      const path = tempDb();
      const { token } = enroll(path);
      const server = yield* startServer(path, [finishes("hi")]);
      const host = testHost();
      const { done, saved } = chat(host, server.url, token, {
        cursor: { stream: streamId.parse("an-older-stream"), seq: 40 },
      });

      host.type("hello");
      host.endInput();
      const code = yield* Effect.promise(() => done);

      expect(code).toBe(0);
      expect(host.stdout()).toBe(
        `[notice] the server's history was restored; continuing from now\n${greeting}hi\n[turn] completed\n`,
      );
      expect(saved[0]).toEqual({
        stream: server.streamId,
        seq: server.history.head() - 2,
      });
      yield* server.stop;
    }),
  );
});

type Script = {
  readonly host: TestHost;
  readonly events: () => SocketEvents;
  readonly frame: (frame: unknown) => void;
  readonly closeWith: (code: number) => void;
};

const scripted = (answerResumes = true): Script => {
  let events: SocketEvents | undefined;
  const host = testHost((_url, _token, given) => {
    events = given;
    return Promise.resolve({
      send: (text) => {
        const sent = JSON.parse(text) as Record<string, unknown>;
        if (
          answerResumes &&
          sent["type"] === "resume" &&
          sent["cursor"] !== null
        ) {
          queueMicrotask(() => {
            given.message(
              JSON.stringify({ v: 1, type: "live", cursor: sent["cursor"] }),
            );
          });
        }
      },
      close: () => undefined,
    });
  });
  return {
    host,
    events: () => {
      if (!events) throw new Error("not connected");
      return events;
    },
    frame: (frame) => {
      events?.message(JSON.stringify(frame));
    },
    closeWith: (code) => {
      events?.close(code);
    },
  };
};

const event = (seq: number, bot: string, text: string) => ({
  v: 1,
  type: "event",
  seq,
  name: "bot.event",
  payload: { bot, turn: "t1", format: 1, event: { type: "text.delta", text } },
});

const base = (host: TestHost, saved: Cursor[] = []) =>
  runChat(
    {
      bot: "chief",
      url: "ws://x/ws",
      token: "aph_dev_0123456789abcdef_secret",
      cursor: { stream: streamId.parse("s1"), seq: 3 },
      saveCursor: (cursor) => saved.push(cursor),
    },
    host,
  );

describe("a chat against a scripted server", () => {
  it("prints only its own bot, advances the cursor on every event and drops repeats", async () => {
    const saved: Cursor[] = [];
    const script = scripted();
    const done = base(script.host, saved);
    await waitFor("the greeting", () => script.host.stdout() !== "");

    script.frame(event(4, "other", "not mine"));
    script.frame(event(5, "chief", "mine"));
    script.frame(event(5, "chief", "again"));
    script.frame(event(2, "chief", "old"));
    script.host.endInput();

    expect(await done).toBe(0);
    expect(script.host.stdout()).toContain("mine");
    expect(script.host.stdout()).not.toContain("not mine");
    expect(script.host.stdout()).not.toContain("again");
    expect(script.host.stdout()).not.toContain("old");
    expect(saved.map(({ seq }) => seq)).toEqual([4, 5]);
  });

  it("sends only non-empty lines", async () => {
    const script = scripted();
    const done = base(script.host);
    await waitFor("the connection", () => script.host.connects() === 1);

    script.host.type("");
    script.host.type("   ");
    script.host.type("hi");
    await waitFor("a prompt", () => script.host.sent().length === 2);
    script.host.interrupt();
    script.host.interrupt();

    expect(await done).toBe(0);
    expect(
      script.host.sent().map((frame) => frame["name"] ?? "resume"),
    ).toEqual(["resume", "bot.prompt"]);
  });

  it("prints an interrupted answer and doesn't send that prompt again", async () => {
    const script = scripted();
    const done = base(script.host);
    await waitFor("the connection", () => script.host.connects() === 1);
    script.host.type("hi");
    await waitFor("a prompt", () => script.host.sent().length === 2);
    const id = script.host.sent()[1]?.["id"];

    script.frame({
      v: 1,
      type: "error",
      id,
      code: "interrupted",
      message: "the server stopped while it ran this command",
    });
    script.closeWith(1006);
    await waitFor("the second connection", () => script.host.connects() === 2);
    script.host.endInput();

    expect(await done).toBe(0);
    expect(script.host.stderr()).toContain(
      "[error] the server stopped while it ran this command",
    );
    expect(
      script.host.sent().filter((frame) => frame["name"] === "bot.prompt"),
    ).toHaveLength(1);
  });

  it.each([1007, 1008])(
    "exits 1 on close code %i without a retry",
    async (code) => {
      const script = scripted();
      const done = base(script.host);
      await waitFor("the connection", () => script.host.connects() === 1);

      script.closeWith(code);

      expect(await done).toBe(1);
      expect(script.host.connects()).toBe(1);
      expect(script.host.stderr().at(-1)).toMatch(/^aphelion: /);
      expect(script.host.everything()).not.toContain("aph_dev_");
    },
  );

  it("gives up after five history failures in a row", async () => {
    const script = scripted(false);
    const done = base(script.host);
    for (let tries = 1; tries <= 5; tries += 1) {
      await waitFor("a connection", () => script.host.connects() === tries);
      script.closeWith(1011);
    }

    expect(await done).toBe(1);
    expect(script.host.connects()).toBe(5);
  });

  it("starts the backoff at 250 ms and grows it while the server is down", async () => {
    let attempts = 0;
    const host = testHost(() => {
      attempts += 1;
      return Promise.reject(new Error("refused"));
    });
    const done = base(host);
    await waitFor("four attempts", () => attempts >= 4);
    host.interrupt();

    expect(await done).toBe(0);
    expect(host.sleeps().slice(0, 3)).toEqual([250, 500, 1000]);
  });

  const names = (host: TestHost) =>
    host.sent().map((frame) => frame["name"] ?? frame["type"]);

  const pause = () => new Promise((resolve) => setTimeout(resolve, 60));

  const live = (seq: number, stream = "s1") => ({
    v: 1,
    type: "live",
    cursor: { stream, seq },
  });

  test("isn't connected, and sends no prompt, until the server says it is live", async () => {
    const script = scripted(false);
    const done = base(script.host);
    await waitFor("the connection", () => script.host.connects() === 1);

    script.host.type("hi");
    await pause();

    expect(names(script.host)).toEqual(["resume"]);
    expect(script.host.stdout()).toBe("");

    script.frame(live(3));
    await waitFor("the prompt", () => script.host.sent().length === 2);
    script.host.interrupt();
    script.host.interrupt();

    expect(await done).toBe(0);
    expect(names(script.host)).toEqual(["resume", "bot.prompt"]);
    expect(script.host.stdout()).toContain("Connected to chief");
  });

  test("shows the replay and does not count as connected until live comes", async () => {
    const script = scripted(false);
    const done = base(script.host);
    await waitFor("the connection", () => script.host.connects() === 1);

    script.frame(event(4, "chief", "replayed"));
    await pause();

    expect(script.host.stdout()).toBe("replayed");
    script.host.type("hi");
    await pause();
    expect(names(script.host)).toEqual(["resume"]);

    script.frame(live(4));
    await waitFor("the prompt", () => script.host.sent().length === 2);
    script.host.interrupt();
    script.host.interrupt();

    expect(await done).toBe(0);
  });

  test("sends a prompt typed during an outage only after live", async () => {
    const script = scripted(false);
    const done = base(script.host);
    await waitFor("the first connection", () => script.host.connects() === 1);
    script.frame(live(3));
    await waitFor("the greeting", () => script.host.stdout() !== "");
    script.closeWith(1006);
    await waitFor("the second connection", () => script.host.connects() === 2);

    script.host.type("hi");
    await pause();
    expect(names(script.host)).toEqual(["resume", "resume"]);
    expect(script.host.stderr()).toEqual([
      "aphelion: lost the connection to the server, trying again",
    ]);

    script.frame(live(3));
    await waitFor("the prompt", () => script.host.sent().length === 3);
    script.host.interrupt();
    script.host.interrupt();

    expect(await done).toBe(0);
    expect(names(script.host)).toEqual(["resume", "resume", "bot.prompt"]);
    expect(script.host.stderr()).toEqual([
      "aphelion: lost the connection to the server, trying again",
      "aphelion: connected again",
    ]);
  });

  test("sends the second resume, then waits for its live, when the server restored its history", async () => {
    const script = scripted(false);
    const done = base(script.host);
    await waitFor("the connection", () => script.host.connects() === 1);
    script.host.type("hi");
    await pause();

    script.frame({
      v: 1,
      type: "resync",
      cursor: { stream: "s2", seq: 9 },
    });
    await waitFor("the second resume", () => script.host.sent().length === 2);
    await pause();
    expect(names(script.host)).toEqual(["resume", "resume"]);

    script.frame(live(9, "s2"));
    await waitFor("the prompt", () => script.host.sent().length === 3);
    script.host.interrupt();
    script.host.interrupt();

    expect(await done).toBe(0);
    expect(names(script.host)).toEqual(["resume", "resume", "bot.prompt"]);
    expect(script.host.sent()[1]?.["cursor"]).toEqual({ stream: "s2", seq: 9 });
    expect(script.host.stdout()).toContain(
      "[notice] the server's history was restored; continuing from now\n",
    );
  });

  test("says it is connected again only after the second resume's live, when a resync comes first", async () => {
    const script = scripted(false);
    const done = base(script.host);
    await waitFor("the first connection", () => script.host.connects() === 1);
    script.frame(live(3));
    await waitFor("the greeting", () => script.host.stdout() !== "");
    script.closeWith(1006);
    await waitFor("the second connection", () => script.host.connects() === 2);

    script.frame({ v: 1, type: "resync", cursor: { stream: "s1", seq: 10 } });
    await waitFor("the second resume", () => script.host.sent().length === 3);
    await pause();
    expect(script.host.stderr()).toEqual([
      "aphelion: lost the connection to the server, trying again",
    ]);

    script.frame(live(10));
    await waitFor("it is back", () => script.host.stderr().length === 2);
    script.host.interrupt();

    expect(await done).toBe(0);
    expect(script.host.stderr()[1]).toBe("aphelion: connected again");
  });

  test("counts a close between the resume and live as the same outage", async () => {
    const script = scripted(false);
    const done = base(script.host);
    await waitFor("the first connection", () => script.host.connects() === 1);
    script.frame(live(3));
    await waitFor("the greeting", () => script.host.stdout() !== "");
    script.closeWith(1006);
    for (let tries = 2; tries <= 4; tries += 1) {
      await waitFor("a connection", () => script.host.connects() === tries);
      script.closeWith(1006);
    }
    await waitFor("a fifth connection", () => script.host.connects() === 5);
    script.frame(live(3));
    await waitFor("it is back", () => script.host.stderr().length === 2);
    script.host.interrupt();

    expect(await done).toBe(0);
    expect(script.host.stderr()).toEqual([
      "aphelion: lost the connection to the server, trying again",
      "aphelion: connected again",
    ]);
    expect(script.host.sleeps().slice(0, 4)).toEqual([250, 500, 1000, 2000]);
  });

  test("moves its cursor to the one in live, and never back", async () => {
    const saved: Cursor[] = [];
    const script = scripted(false);
    const done = base(script.host, saved);
    await waitFor("the connection", () => script.host.connects() === 1);

    script.frame(live(8));
    await waitFor("the greeting", () => script.host.stdout() !== "");
    script.frame(live(5));
    script.host.interrupt();

    expect(await done).toBe(0);
    expect(saved).toEqual([{ stream: streamId.parse("s1"), seq: 8 }]);
  });

  test("ignores a second live on the same connection", async () => {
    const script = scripted();
    const done = base(script.host);
    await waitFor("the greeting", () => script.host.stdout() !== "");
    script.host.type("hi");
    await waitFor("the prompt", () => script.host.sent().length === 2);

    script.frame(live(3));
    await pause();
    script.host.interrupt();
    script.host.interrupt();

    expect(await done).toBe(0);
    expect(
      script.host.sent().filter((frame) => frame["name"] === "bot.prompt"),
    ).toHaveLength(1);
  });

  test("resumes without a notice when the resync names the same stream", async () => {
    const saved: Cursor[] = [];
    const script = scripted(false);
    const done = base(script.host, saved);
    await waitFor("the resume", () => script.host.sent().length === 1);

    script.frame({
      v: 1,
      type: "resync",
      cursor: { stream: "s1", seq: 10 },
    });
    await waitFor("the second resume", () => script.host.sent().length === 2);
    script.host.interrupt();

    expect(await done).toBe(0);
    expect(script.host.sent()[1]?.["cursor"]).toEqual({
      stream: "s1",
      seq: 10,
    });
    expect(saved.at(-1)).toEqual({ stream: "s1", seq: 10 });
    expect(script.host.stdout()).not.toContain("[notice]");
  });

  test("says once that the connection is lost, and not that it is back, while the server keeps closing with 1011", async () => {
    const script = scripted(false);
    const done = base(script.host);
    for (let tries = 1; tries <= 3; tries += 1) {
      await waitFor("a connection", () => script.host.connects() === tries);
      script.closeWith(1011);
    }
    await waitFor("a fourth connection", () => script.host.connects() === 4);
    script.host.interrupt();

    expect(await done).toBe(0);
    expect(script.host.stderr()).toEqual([
      "aphelion: lost the connection to the server, trying again",
    ]);
    expect(script.host.stdout()).toBe("");
  });

  test("starts the backoff over after each live, with nothing to replay", async () => {
    const script = scripted();
    const done = base(script.host);
    await waitFor("the first connection", () => script.host.connects() === 1);
    await waitFor("the greeting", () => script.host.stdout() !== "");
    script.closeWith(1006);
    await waitFor("the second connection", () => script.host.connects() === 2);
    await waitFor("it is back", () => script.host.stderr().length === 2);
    script.closeWith(1006);
    await waitFor("the third connection", () => script.host.connects() === 3);
    script.host.interrupt();

    expect(await done).toBe(0);
    expect(script.host.sleeps().slice(0, 2)).toEqual([250, 250]);
  });

  test("recovers from a 1011 onto an idle stream: says it is back and starts the backoff over", async () => {
    const script = scripted();
    const done = base(script.host);
    await waitFor("the greeting", () => script.host.stdout() !== "");
    script.closeWith(1011);
    await waitFor("the second connection", () => script.host.connects() === 2);
    await waitFor("it is back", () => script.host.stderr().length === 2);
    script.closeWith(1006);
    await waitFor("the third connection", () => script.host.connects() === 3);
    await waitFor("it is back again", () => script.host.stderr().length === 4);
    script.host.interrupt();

    expect(await done).toBe(0);
    expect(script.host.stderr()).toEqual([
      "aphelion: lost the connection to the server, trying again",
      "aphelion: connected again",
      "aphelion: lost the connection to the server, trying again",
      "aphelion: connected again",
    ]);
    expect(script.host.sleeps().slice(0, 2)).toEqual([250, 250]);
  });

  test("doesn't add up isolated 1011 closes between healthy reconnects", async () => {
    const script = scripted();
    const done = base(script.host);
    await waitFor("the greeting", () => script.host.stdout() !== "");
    for (let closes = 1; closes <= 7; closes += 1) {
      script.closeWith(1011);
      await waitFor(
        "a connection",
        () => script.host.connects() === closes + 1,
      );
      await waitFor(
        "it is back",
        () => script.host.stderr().length === 2 * closes,
      );
    }
    script.host.interrupt();

    expect(await done).toBe(0);
    expect(script.host.stderr().at(-1)).toBe("aphelion: connected again");
  });

  test("sends a cancel again after a reconnect when the first one was lost with the connection", async () => {
    const script = scripted();
    const done = base(script.host);
    await waitFor("the greeting", () => script.host.stdout() !== "");
    script.host.type("hi");
    await waitFor("the prompt", () => script.host.sent().length === 2);
    script.frame({
      v: 1,
      type: "result",
      id: script.host.sent()[1]?.["id"],
      name: "bot.prompt",
      result: { turn: "t1" },
    });

    script.host.interrupt();
    await waitFor("the cancel", () =>
      names(script.host).includes("bot.cancel"),
    );
    script.closeWith(1006);
    await waitFor(
      "the second cancel",
      () =>
        names(script.host).filter((name) => name === "bot.cancel").length === 2,
    );
    script.host.interrupt();

    expect(await done).toBe(0);
    const cancels = script.host
      .sent()
      .filter((frame) => frame["name"] === "bot.cancel");
    expect(cancels.map((frame) => frame["payload"])).toEqual([
      { bot: "chief", turn: "t1" },
      { bot: "chief", turn: "t1" },
    ]);
  });

  test("stops the pause between attempts when the chat ends", async () => {
    const host = testHost(() => Promise.reject(new Error("refused")));
    const done = base(host);
    await waitFor("two sleeps", () => host.sleeps().length >= 2);
    host.interrupt();

    expect(await done).toBe(0);
    expect(host.sleepSignals().at(-1)?.aborted).toBe(true);
  });
});
