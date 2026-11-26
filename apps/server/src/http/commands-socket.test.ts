import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterMethods, sessionRef } from "@aphelion/plugin-sdk";
import { fakeAdapter, type FakeScript } from "@aphelion/plugin-sdk/testing";
import {
  commandId,
  streamId,
  type CommandFrame,
  type ServerFrame,
} from "@aphelion/protocol";
import { expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Layer, Scope } from "effect";
import { HttpServer } from "effect/http";
import { onTestFinished } from "vitest";
import { BotRunnerLink } from "../bots/manager";
import {
  fakeBotProcesses,
  fakeRunnerLink,
  memorySessionRefs,
} from "../bots/test-fixture";
import { openCommandLedger } from "../commands";
import { addDevice } from "../devices";
import { openEventStore, runBots } from "../history";
import { createLogger } from "../log";
import { openStore, readServerId, readStreamId } from "../store";
import { serveHttp } from "./index";
import { connectClient } from "./test-client";

const lines: Record<string, unknown>[] = [];
const logger = createLogger({
  write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
});

const finishes: FakeScript[number] = [
  { emit: { type: "session", ref: sessionRef.parse("vendor-secret-ref") } },
  { emit: { type: "text.delta", text: "done" } },
  { emit: { type: "turn.end", reason: "completed" } },
];

const hangs: FakeScript[number] = [
  { emit: { type: "text.delta", text: "working" } },
  { waitForAbort: true },
];

const startServer = (dbPath: string, script: FakeScript) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const db = openStore(dbPath);
    const fake = fakeBotProcesses({
      chief: { adapter: () => fakeAdapter(script) },
    });
    const server = yield* Effect.gen(function* () {
      const link = yield* fakeRunnerLink(fake, logger);
      const links = yield* Layer.build(
        Layer.mergeAll(Layer.succeed(BotRunnerLink, link), memorySessionRefs),
      );
      const history = yield* openEventStore(db, readServerId(db), { logger });
      const ledger = yield* openCommandLedger(db, logger);
      const manager = yield* runBots(
        {
          bots: [
            {
              name: "chief",
              provider: "fake",
              folder: "/var/lib/aphelion-bots/chief",
            },
          ],
          logger,
          adapters: { fake: "/adapters/fake/adapter.js" },
          stopDeadlineMs: 5_000,
        },
        history,
      ).pipe(Effect.provideContext(links));
      const context = yield* Layer.buildWithScope(
        serveHttp(
          { address: "127.0.0.1", port: 0 },
          db,
          history,
          { bots: manager, ledger, logger },
          { recheckEvery: Duration.seconds(30) },
        ),
        scope,
      );
      const url = yield* HttpServer.addressFormattedWith(Effect.succeed).pipe(
        Effect.provideContext(context),
      );
      yield* manager.waitFor("chief", (state) => state.state === "running");
      return { url, history };
    }).pipe(Scope.provide(scope));
    return {
      ...server,
      db,
      turnsStarted: () =>
        fake.runs
          .flatMap((run) => run.received)
          .filter(({ method }) => method === adapterMethods.turnStart).length,
      stop: Scope.close(scope, Exit.void).pipe(
        Effect.andThen(
          Effect.sync(() => {
            db.close();
          }),
        ),
      ),
    };
  });

const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), "aphelion-commands-socket-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true });
  });
  return join(dir, "aphelion.db");
};

const deviceToken = (path: string) => {
  const db = openStore(path);
  const { token } = addDevice(db, { name: "laptop" });
  db.close();
  return token;
};

const prompt = (id: string, text = "Hello"): CommandFrame => ({
  v: 1,
  type: "command",
  id: commandId.parse(id),
  name: "bot.prompt",
  payload: { bot: "chief", text },
});

const answerTo = (frames: readonly ServerFrame[], id: string) =>
  frames.find(
    (frame) =>
      (frame.type === "result" || frame.type === "error") && frame.id === id,
  );

it.live(
  "runs one turn for a command that repeats after the server restarted",
  () =>
    Effect.gen(function* () {
      const path = tempDb();
      const token = deviceToken(path);
      const first = yield* startServer(path, [finishes]);
      const before = yield* connectClient(first.url, token);
      before.send(prompt("c1"));
      const [answer] = yield* before.until(1);
      before.close();
      yield* first.stop;

      const second = yield* startServer(path, [finishes]);
      const after = yield* connectClient(second.url, token);
      after.send(prompt("c1"));
      const [repeat] = yield* after.until(1);
      after.close();

      expect(answer).toMatchObject({ type: "result", name: "bot.prompt" });
      expect(repeat).toEqual(answer);
      expect(first.turnsStarted()).toBe(1);
      expect(second.turnsStarted()).toBe(0);
      expect(second.db.all("SELECT COUNT(*) AS turns FROM turns")).toEqual([
        { turns: 1 },
      ]);
      yield* second.stop;
    }),
);

it.live(
  "answers a command that a crash left running with interrupted, and doesn't run it",
  () =>
    Effect.gen(function* () {
      const path = tempDb();
      const token = deviceToken(path);
      const db = openStore(path);
      const device = db.all("SELECT id FROM devices")[0]?.["id"] ?? null;
      db.run(
        "INSERT INTO commands (device, id, name, state, created_at) VALUES (?, 'c1', 'bot.prompt', 'running', ?)",
        [device, Date.now()],
      );
      db.close();

      const server = yield* startServer(path, [finishes]);
      const client = yield* connectClient(server.url, token);
      client.send(prompt("c1"));
      const [answer] = yield* client.until(1);
      client.close();

      expect(answer).toMatchObject({
        type: "error",
        id: "c1",
        code: "interrupted",
      });
      expect(server.turnsStarted()).toBe(0);
      yield* server.stop;
    }),
);

it.live(
  "finishes a prompt whose client left, and gives the same turn to its repeat",
  () =>
    Effect.gen(function* () {
      const path = tempDb();
      const token = deviceToken(path);
      const server = yield* startServer(path, [finishes]);
      const gone = yield* connectClient(server.url, token);
      gone.send(prompt("c1"));
      gone.close();
      yield* Effect.sleep("100 millis");

      const back = yield* connectClient(server.url, token);
      back.send(prompt("c1"));
      const [repeat] = yield* back.until(1);
      back.close();

      expect(repeat).toMatchObject({ type: "result", name: "bot.prompt" });
      expect(server.turnsStarted()).toBe(1);
      yield* server.stop;
    }),
);

it.live(
  "reads a bot's history without the session ref, as replay shows it",
  () =>
    Effect.gen(function* () {
      const path = tempDb();
      const token = deviceToken(path);
      const server = yield* startServer(path, [finishes]);
      const client = yield* connectClient(server.url, token);
      client.send(prompt("c1"));
      yield* client.until(1);
      yield* Effect.repeat(Effect.sleep("20 millis"), {
        until: () => server.history.head() >= 3,
      });
      client.send({
        v: 1,
        type: "command",
        id: commandId.parse("r1"),
        name: "history.read",
        payload: { bot: "chief", limit: 50 },
      });
      client.send({
        v: 1,
        type: "resume",
        cursor: { stream: streamId.parse(readStreamId(server.db)), seq: 0 },
      });
      const frames = yield* client.until(4);
      client.close();

      const read = answerTo(frames, "r1");
      const replayed = frames.flatMap((frame) =>
        frame.type === "event" && frame.name === "bot.event"
          ? [{ seq: frame.seq, payload: frame.payload }]
          : [],
      );
      expect(read).toMatchObject({ type: "result", name: "history.read" });
      expect(read?.type === "result" && read.result).toMatchObject({
        events: replayed,
        more: false,
      });
      expect(JSON.stringify(frames)).not.toContain("vendor-secret-ref");
      yield* server.stop;
    }),
);

it.live("cancels a turn that a client asked to cancel", () =>
  Effect.gen(function* () {
    const path = tempDb();
    const token = deviceToken(path);
    const server = yield* startServer(path, [hangs]);
    const client = yield* connectClient(server.url, token);
    client.send(prompt("c1"));
    const [answer] = yield* client.until(1);
    const turn =
      answer?.type === "result" && answer.name === "bot.prompt"
        ? answer.result.turn
        : "";
    yield* server.history.flush;

    client.send({
      v: 1,
      type: "command",
      id: commandId.parse("x1"),
      name: "bot.cancel",
      payload: { bot: "chief", turn },
    });
    const frames = yield* client.until(2);
    client.close();
    yield* Effect.repeat(Effect.sleep("20 millis"), {
      until: () =>
        server.db.all(
          "SELECT end_reason FROM turns WHERE end_reason IS NOT NULL",
        ).length > 0,
    });

    expect(answerTo(frames, "x1")).toMatchObject({
      type: "result",
      name: "bot.cancel",
      result: {},
    });
    expect(
      server.db.all("SELECT end_reason FROM turns WHERE id = ?", [turn]),
    ).toEqual([{ end_reason: "cancelled" }]);
    yield* server.stop;
  }),
);
