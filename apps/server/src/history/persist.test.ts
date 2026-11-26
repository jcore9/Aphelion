import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterEnvelope } from "@aphelion/plugin-sdk";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, PubSub, Scope } from "effect";
import { TestClock } from "effect/testing";
import { onTestFinished } from "vitest";
import type { BotEvent } from "../bots/manager";
import { createLogger } from "../log";
import { openStore, readServerId } from "../store";
import { openEventStore } from "./event-store";
import { persistBotEvents } from "./persist";

const botEvent = (bot: string, raw: unknown): BotEvent => ({
  bot,
  run: 1,
  envelope: adapterEnvelope.parse(raw),
});

it.effect("saves every event a bot publishes, from the first one on", () =>
  Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), "aphelion-persist-"));
    onTestFinished(() => {
      rmSync(dir, { recursive: true });
    });
    const db = openStore(join(dir, "aphelion.db"));
    onTestFinished(() => {
      db.close();
    });
    const store = yield* openEventStore(db, readServerId(db), {
      logger: createLogger({ write: () => undefined }),
    });
    yield* store.openTurn("scout", "t1");
    const published = yield* PubSub.unbounded<BotEvent>();
    yield* persistBotEvents(PubSub.subscribe(published), store);

    yield* PubSub.publish(
      published,
      botEvent("chief", {
        seq: 1,
        turn: null,
        event: { type: "session", ref: "s-1" },
      }),
    );
    yield* PubSub.publish(
      published,
      botEvent("scout", {
        seq: 1,
        turn: "t1",
        event: { type: "text.delta", text: "hi" },
      }),
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust("50 millis");

    expect(
      db.all("SELECT position, bot, turn, kind FROM events ORDER BY position"),
    ).toEqual([
      { position: 1, bot: "chief", turn: null, kind: "session" },
      { position: 2, bot: "scout", turn: "t1", kind: "text.delta" },
    ]);
  }).pipe(Effect.scoped),
);

it.effect(
  "saves events that are still queued in the subscription when the scope closes",
  () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "aphelion-persist-"));
      onTestFinished(() => {
        rmSync(dir, { recursive: true });
      });
      const db = openStore(join(dir, "aphelion.db"));
      onTestFinished(() => {
        db.close();
      });
      const published = yield* PubSub.unbounded<BotEvent>();
      const app = yield* Scope.make();
      yield* Effect.gen(function* () {
        const store = yield* openEventStore(db, readServerId(db), {
          logger: createLogger({ write: () => undefined }),
        });
        yield* store.openTurn("chief", "t1");
        yield* persistBotEvents(PubSub.subscribe(published), store);
      }).pipe(Scope.provide(app));

      for (let seq = 1; seq <= 300; seq++) {
        yield* PubSub.publish(
          published,
          botEvent("chief", {
            seq,
            turn: "t1",
            event: { type: "text.delta", text: String(seq) },
          }),
        );
      }
      yield* Scope.close(app, Exit.void);

      expect(db.all("SELECT COUNT(*) AS saved FROM events")[0]?.["saved"]).toBe(
        300,
      );
    }),
);
