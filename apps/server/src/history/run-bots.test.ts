import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionRef, turnId } from "@aphelion/plugin-sdk";
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
    const manager = yield* Effect.gen(function* () {
      const history = yield* openEventStore(db, readServerId(db), { logger });
      return yield* runBots(
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
    }).pipe(Scope.provide(app));
    return {
      db,
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
    yield* manager.startTurn("chief", turnId.parse("t1"), "hi");
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
