import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionRef } from "@aphelion/plugin-sdk";
import { fakeAdapter, type FakeScript } from "@aphelion/plugin-sdk/testing";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Scope } from "effect";
import { onTestFinished } from "vitest";
import { BotRunnerLink } from "../bots/manager";
import {
  fakeBotProcesses,
  fakeRunnerLink,
  memorySessionRefs,
} from "../bots/test-fixture";
import { createLogger } from "../log";
import { openStore, readServerId } from "../store";
import { openEventStore } from "./event-store";
import { closeDanglingTurns } from "./repair";
import { runBots } from "./run-bots";

const logger = createLogger({ write: () => undefined });

const sessionThenHang: FakeScript[number] = [
  { emit: { type: "session", ref: sessionRef.parse("s-1") } },
  { emit: { type: "text.delta", text: "working" } },
  { hang: true },
];

const startServer = (dbPath: string, scripts: Record<string, FakeScript>) =>
  Effect.gen(function* () {
    const app = yield* Scope.make();
    const db = openStore(dbPath);
    const fake = fakeBotProcesses(
      Object.fromEntries(
        Object.entries(scripts).map(([name, script]) => [
          name,
          { adapter: () => fakeAdapter(script) },
        ]),
      ),
    );
    const link = yield* fakeRunnerLink(fake, logger);
    const services = yield* Layer.build(
      Layer.mergeAll(Layer.succeed(BotRunnerLink, link), memorySessionRefs),
    );
    const { history, manager } = yield* Effect.gen(function* () {
      const history = yield* openEventStore(db, readServerId(db), { logger });
      const manager = yield* runBots(
        {
          bots: Object.keys(scripts).map((name) => ({
            name,
            provider: "fake",
            folder: `/var/lib/aphelion-bots/${name}`,
          })),
          logger,
          adapters: { fake: "/adapters/fake/adapter.js" },
          stopDeadlineMs: 5_000,
        },
        history,
      ).pipe(Effect.provideContext(services));
      return { history, manager };
    }).pipe(Scope.provide(app));
    return {
      db,
      history,
      manager,
      stop: Scope.close(app, Exit.void),
    };
  });

const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), "aphelion-run-bots-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true });
  });
  return join(dir, "aphelion.db");
};

it.live("saves the events a stopping bot emits as the server shuts down", () =>
  Effect.gen(function* () {
    const { db, manager, stop } = yield* startServer(tempDb(), {
      chief: [sessionThenHang],
    });
    yield* manager.waitFor("chief", (state) => state.state === "running");
    yield* manager.startTurn("chief", "hi");
    yield* manager.waitFor("chief", (state) => state.state === "in turn");
    yield* Effect.sleep("20 millis");

    yield* stop;

    const kinds = db
      .all("SELECT kind FROM events ORDER BY position")
      .map((row) => row["kind"]);
    expect(kinds).toEqual(["session", "text.delta", "turn.end"]);
    db.close();
  }).pipe(Effect.scoped),
);

const finishes: FakeScript[number] = [
  { emit: { type: "text.delta", text: "done" } },
  { emit: { type: "turn.end", reason: "completed" } },
];

it.live(
  "gives two bots their own turns, so boot repair finds only the one still open",
  () =>
    Effect.gen(function* () {
      const { db, manager, history, stop } = yield* startServer(tempDb(), {
        chief: [finishes],
        scout: [
          [{ emit: { type: "text.delta", text: "busy" } }, { hang: true }],
        ],
      });
      yield* manager.waitFor("chief", (state) => state.state === "running");
      yield* manager.waitFor("scout", (state) => state.state === "running");
      const done = yield* manager.startTurn("chief", "hi");
      yield* manager.waitFor("chief", (state) => state.state === "running");
      const open = yield* manager.startTurn("scout", "hi");
      yield* history.flush;
      yield* Effect.sleep("50 millis");
      yield* history.flush;

      expect(done.turn).not.toBe(open.turn);
      expect((yield* closeDanglingTurns(db, history, logger)).turns).toBe(1);
      expect(
        db.all("SELECT id, bot, end_reason FROM turns ORDER BY bot"),
      ).toEqual([
        { id: done.turn, bot: "chief", end_reason: "completed" },
        { id: open.turn, bot: "scout", end_reason: "error" },
      ]);
      yield* stop;
      db.close();
    }).pipe(Effect.scoped),
);
