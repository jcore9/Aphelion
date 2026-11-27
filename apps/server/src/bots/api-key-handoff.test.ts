import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionRef } from "@aphelion/plugin-sdk";
import { fakeAdapter, type FakeScript } from "@aphelion/plugin-sdk/testing";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { describe, onTestFinished } from "vitest";
import { openEventStore, runBots } from "../history";
import { createLogger } from "../log";
import { BrokerError } from "../secrets/broker-client";
import { Secret } from "../secrets";
import { openStore, readServerId } from "../store";
import {
  apiKeyReadFailed,
  BotManager,
  botManagerLayer,
  BotRunnerLink,
  type ApiKeySource,
  type BotState,
} from "./manager";
import type { RunnerRequest } from "./runner-protocol";
import {
  fakeBotProcesses,
  fakeRunnerLink,
  memorySessionRefs,
} from "./test-fixture";

const fakeKey = "sk-ant-fake-handoff-canary-0123456789abcdef";

const turnScript: FakeScript[number] = [
  { emit: { type: "session", ref: sessionRef.parse("s-1") } },
  { emit: { type: "text.delta", text: "done" } },
  { emit: { type: "turn.end", reason: "completed" } },
];

const bots = [
  { name: "chief", provider: "claude", folder: "/var/lib/aphelion-bots/chief" },
  { name: "scout", provider: "codex", folder: "/var/lib/aphelion-bots/scout" },
  { name: "plain", provider: "fake", folder: "/var/lib/aphelion-bots/plain" },
];

const adapters = { claude: "fake", codex: "fake", fake: "fake" };

type Broker = "stored" | "missing" | "broken";

const keySource = (broker: Broker) => {
  const reads: string[] = [];
  const handed: Secret[] = [];
  const source: ApiKeySource = {
    read: (ref) => {
      reads.push(ref);
      if (broker === "broken") {
        return Promise.reject(
          new BrokerError(`the broker broke while holding ${fakeKey}`),
        );
      }
      if (broker === "missing" || ref !== "local://apikey/claude") {
        return Promise.resolve(undefined);
      }
      const secret = Secret.make(fakeKey, { label: "API key" });
      handed.push(secret);
      return Promise.resolve(secret);
    },
  };
  return { source, reads, handed };
};

const fakes = () =>
  fakeBotProcesses(
    Object.fromEntries(
      bots.map((bot) => [
        bot.name,
        { adapter: () => fakeAdapter([turnScript], bot.provider) },
      ]),
    ),
  );

const system = (broker: Broker) =>
  Effect.gen(function* () {
    const fake = fakes();
    const keys = keySource(broker);
    const logs: string[] = [];
    const logger = createLogger({ write: (line) => logs.push(line) });
    const link = yield* fakeRunnerLink(fake, logger);
    const sent: RunnerRequest[] = [];
    const services = yield* Layer.build(
      botManagerLayer({
        bots,
        logger,
        adapters,
        apiKeys: keys.source,
      }).pipe(
        Layer.provideMerge(memorySessionRefs),
        Layer.provide(
          Layer.succeed(BotRunnerLink, {
            incoming: link.incoming,
            send: (message) => {
              sent.push(message);
              return link.send(message);
            },
          }),
        ),
      ),
    );
    const manager = Context.get(services, BotManager);
    const runningAll = Effect.forEach(bots, (bot) =>
      manager
        .waitFor(bot.name, (state: BotState) => state.state === "running")
        .pipe(Effect.timeout("5 seconds"), Effect.orDie),
    );
    for (const bot of bots) yield* manager.start(bot.name);
    yield* runningAll;
    return { fake, keys, logs, sent, manager };
  });

const specKey = (
  fake: ReturnType<typeof fakes>,
  bot: string,
): Secret | undefined =>
  fake.runs.find((run) => run.spec.bot === bot)?.spec.apiKey;

describe("the API key at bot start", () => {
  it.live(
    "reads the key for the bot's provider at start, hands it only to that bot, and wipes the server's copy once the start is sent",
    () =>
      Effect.gen(function* () {
        const { fake, keys, logs, sent } = yield* system("stored");
        expect(keys.reads.sort()).toEqual([
          "local://apikey/claude",
          "local://apikey/codex",
        ]);
        expect(specKey(fake, "chief")?.reveal().length).toBe(fakeKey.length);
        expect(specKey(fake, "scout")).toBeUndefined();
        expect(specKey(fake, "plain")).toBeUndefined();
        const starts = sent.filter((frame) => frame.type === "start");
        expect(
          starts.map((frame) => [frame.bot, "apiKey" in frame]).sort(),
        ).toEqual([
          ["chief", true],
          ["plain", false],
          ["scout", false],
        ]);
        expect(keys.handed).toHaveLength(1);
        expect(keys.handed[0]?.wiped).toBe(true);
        expect(logs.join("\n")).not.toContain(fakeKey);
      }).pipe(Effect.scoped),
  );

  it.live(
    "starts the bot without a key, and logs nothing, when no key is stored",
    () =>
      Effect.gen(function* () {
        const { fake, logs } = yield* system("missing");
        expect(specKey(fake, "chief")).toBeUndefined();
        expect(logs.join("\n")).not.toContain(apiKeyReadFailed);
      }).pipe(Effect.scoped),
  );

  it.live(
    "starts the bot without a key and logs one fixed line, never the error, when the broker fails",
    () =>
      Effect.gen(function* () {
        const { fake, logs } = yield* system("broken");
        expect(specKey(fake, "chief")).toBeUndefined();
        const failures = logs.filter((line) => line.includes(apiKeyReadFailed));
        expect(failures).toHaveLength(2);
        expect(failures.map((line) => JSON.parse(line) as unknown)).toEqual([
          expect.objectContaining({ msg: apiKeyReadFailed }),
          expect.objectContaining({ msg: apiKeyReadFailed }),
        ]);
        expect(logs.join("\n")).not.toContain(fakeKey);
        expect(logs.join("\n")).not.toContain("broke while holding");
      }).pipe(Effect.scoped),
  );

  it.live("keeps the key out of every history row after a turn", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "aphelion-key-history-"));
      onTestFinished(() => {
        rmSync(dir, { recursive: true });
      });
      const db = openStore(join(dir, "aphelion.db"));
      const fake = fakes();
      const keys = keySource("stored");
      const logs: string[] = [];
      const logger = createLogger({ write: (line) => logs.push(line) });
      const app = yield* Scope.make();
      const link = yield* fakeRunnerLink(fake, logger);
      const services = yield* Layer.build(
        Layer.mergeAll(Layer.succeed(BotRunnerLink, link), memorySessionRefs),
      );
      const history = yield* openEventStore(db, readServerId(db), {
        logger,
      }).pipe(Scope.provide(app));
      const manager = yield* runBots(
        { bots, logger, adapters, apiKeys: keys.source },
        history,
      ).pipe(Effect.provideContext(services), Scope.provide(app));
      yield* manager
        .waitFor("chief", (state) => state.state === "running")
        .pipe(Effect.timeout("5 seconds"), Effect.orDie);
      yield* manager.startTurn("chief", "hi");
      yield* manager
        .waitFor("chief", (state) => state.state === "running")
        .pipe(Effect.timeout("5 seconds"), Effect.orDie);
      yield* history.flush;
      yield* Scope.close(app, Exit.void);
      expect(specKey(fake, "chief")?.wiped).toBe(true);
      const tables = db
        .all("SELECT name FROM sqlite_master WHERE type = 'table'")
        .map((row) => String(row["name"]));
      const rows = tables.flatMap((table) =>
        db.all(`SELECT * FROM "${table}"`),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain(fakeKey);
      expect(logs.join("\n")).not.toContain(fakeKey);
      db.close();
    }).pipe(Effect.scoped),
  );
});
