import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterMethods } from "@aphelion/plugin-sdk";
import { fakeAdapter, type FakeScript } from "@aphelion/plugin-sdk/testing";
import { Duration, Effect, Exit, Layer, Scope } from "effect";
import { HttpServer } from "effect/http";
import { onTestFinished } from "vitest";
import { BotRunnerLink } from "../../bots/manager";
import {
  fakeBotProcesses,
  fakeRunnerLink,
  memorySessionRefs,
} from "../../bots/test-fixture";
import { createAdmission, openCommandLedger } from "../../commands";
import { addDevice, revokeDevice } from "../../devices";
import { openEventStore, runBots } from "../../history";
import { serveHttp } from "../../http";
import { createLogger } from "../../log";
import { openStore, readServerId, readStreamId } from "../../store";

const logger = createLogger({ write: () => undefined });

export const startServer = (
  dbPath: string,
  script: FakeScript,
  options: { readonly port?: number; readonly recheckMillis?: number } = {},
) =>
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
          adapters: { fake: "fake" },
          stopDeadlineMs: 5_000,
        },
        history,
      ).pipe(Effect.provideContext(links));
      const context = yield* Layer.buildWithScope(
        serveHttp(
          { address: "127.0.0.1", port: options.port ?? 0 },
          db,
          history,
          { bots: manager, ledger, admission: createAdmission(), logger },
          {
            recheckEvery: Duration.millis(options.recheckMillis ?? 30_000),
          },
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
      port: Number(new URL(server.url).port),
      streamId: readStreamId(db),
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

export const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), "aphelion-chat-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true });
  });
  return join(dir, "aphelion.db");
};

export const enroll = (path: string) => {
  const db = openStore(path);
  const device = addDevice(db, { name: "laptop" });
  db.close();
  return device;
};

export const revoke = (path: string, id: string) => {
  const db = openStore(path);
  revokeDevice(db, id);
  db.close();
};
