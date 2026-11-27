import {
  commandFailures,
  type CommandFailure,
  type CommandId,
  type CommandName,
} from "@aphelion/protocol";
import { Clock, Deferred, Duration, Effect, Exit, Scope } from "effect";
import { z } from "zod";
import type { DeviceId } from "../devices";
import type { Logger } from "../log";
import type { Database, Row } from "../store";
import type { Permit } from "./admission";

export type Outcome =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly code: CommandFailure };

export interface CommandEntry {
  readonly device: DeviceId;
  readonly id: CommandId;
  readonly name: CommandName;
}

export interface CommandLedger {
  readonly run: (
    entry: CommandEntry,
    apply: Effect.Effect<Outcome>,
    permit?: Permit,
  ) => Effect.Effect<Outcome>;
}

const windowMs = Duration.toMillis(Duration.hours(24));
const purgeEvery = Duration.hours(1);
export const commandDrainDeadlineMs = 2_000;
export const resultWriteBackoff = [
  Duration.millis(100),
  Duration.millis(500),
  Duration.seconds(2),
] as const;

const failure = z.enum(commandFailures).catch("interrupted");

const failed = (code: CommandFailure): Outcome => ({ ok: false, code });

interface Running {
  readonly name: CommandName;
  readonly done: Deferred.Deferred<Outcome>;
}

type Claim =
  | { readonly type: "known"; readonly outcome: Outcome }
  | { readonly type: "running"; readonly done: Deferred.Deferred<Outcome> }
  | { readonly type: "new"; readonly done: Deferred.Deferred<Outcome> };

const savedOutcome = (row: Row, name: CommandName): Outcome => {
  if (row["name"] !== name) return failed("id-reused");
  if (row["state"] === "done") {
    return { ok: true, result: JSON.parse(String(row["result"])) };
  }
  return failed(failure.parse(row["result"] ?? undefined));
};

export const openCommandLedger = (db: Database, logger: Logger) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const executions = yield* Scope.make();
    const running = new Map<string, Running>();
    let closing = false;

    const drain: Effect.Effect<void> = Effect.suspend(() => {
      const active = [...running.values()].map(({ done }) =>
        Deferred.await(done),
      );
      if (active.length === 0) return Effect.void;
      return Effect.all(active, {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.andThen(drain));
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closing = true;
      }).pipe(
        Effect.andThen(
          drain.pipe(
            Effect.timeoutOption(commandDrainDeadlineMs),
            Effect.asVoid,
          ),
        ),
        Effect.andThen(Scope.close(executions, Exit.void)),
      ),
    );

    const purge = Effect.flatMap(Clock.currentTimeMillis, (at) =>
      Effect.sync(() => {
        db.transaction(() => {
          const old = db.all(
            "SELECT device, id FROM commands WHERE created_at <= ?",
            [at - windowMs],
          );
          for (const { device, id } of old) {
            if (running.has(`${String(device)}:${String(id)}`)) continue;
            db.run("DELETE FROM commands WHERE device = ? AND id = ?", [
              device ?? null,
              id ?? null,
            ]);
          }
        });
      }),
    );

    const settleLeftovers = Effect.sync(() => {
      db.transaction(() => {
        const left = db.all(
          "SELECT COUNT(*) AS count FROM commands WHERE state = 'running'",
        )[0]?.["count"];
        db.run(
          "UPDATE commands SET state = 'failed', result = 'interrupted' WHERE state = 'running'",
        );
        if (typeof left === "number" && left > 0) {
          logger.warn(
            "commands that the last run left open now answer as interrupted",
            { count: left },
          );
        }
      });
    });

    yield* settleLeftovers.pipe(Effect.andThen(purge));
    const purgeOrLog = purge.pipe(
      Effect.catchCause(() =>
        Effect.sync(() => {
          logger.error("deleting old commands failed");
        }),
      ),
    );
    yield* Effect.sleep(purgeEvery).pipe(
      Effect.andThen(purgeOrLog),
      Effect.forever,
      Effect.forkIn(scope),
    );

    const claim = (entry: CommandEntry, at: number): Claim => {
      const key = `${entry.device}:${entry.id}`;
      const active = running.get(key);
      if (active !== undefined) {
        return active.name === entry.name
          ? { type: "running", done: active.done }
          : { type: "known", outcome: failed("id-reused") };
      }
      return db.transaction(() => {
        const row = db.all(
          "SELECT name, state, result, created_at FROM commands WHERE device = ? AND id = ?",
          [entry.device, entry.id],
        )[0];
        if (row !== undefined && at - Number(row["created_at"]) < windowMs) {
          return { type: "known", outcome: savedOutcome(row, entry.name) };
        }
        if (closing) {
          return { type: "known", outcome: failed("interrupted") };
        }
        db.run("DELETE FROM commands WHERE device = ? AND id = ?", [
          entry.device,
          entry.id,
        ]);
        db.run(
          "INSERT INTO commands (device, id, name, state, created_at) VALUES (?, ?, ?, 'running', ?)",
          [entry.device, entry.id, entry.name, at],
        );
        const done = Deferred.makeUnsafe<Outcome>();
        running.set(key, { name: entry.name, done });
        return { type: "new", done };
      });
    };

    const saveResult = (entry: CommandEntry, outcome: Outcome) =>
      Effect.try({
        try: () =>
          db.all(
            "UPDATE commands SET state = ?, result = ? WHERE device = ? AND id = ? RETURNING 1 AS saved",
            [
              outcome.ok ? "done" : "failed",
              outcome.ok ? JSON.stringify(outcome.result) : outcome.code,
              entry.device,
              entry.id,
            ],
          ).length,
        catch: (error) => (error instanceof Error ? error.name : "unknown"),
      });

    const saveWithRetries = (entry: CommandEntry, outcome: Outcome) =>
      Effect.gen(function* () {
        for (const wait of [Duration.zero, ...resultWriteBackoff]) {
          yield* Effect.sleep(wait);
          const saved = yield* Effect.result(saveResult(entry, outcome));
          if (saved._tag === "Success" && saved.success === 1) return true;
          logger.error("saving a command's result failed", {
            error:
              saved._tag === "Success" ? "no row to update" : saved.failure,
          });
          if (saved._tag === "Success") return false;
        }
        return false;
      });

    const settle = (
      entry: CommandEntry,
      done: Deferred.Deferred<Outcome>,
      outcome: Outcome,
    ) =>
      saveWithRetries(entry, outcome).pipe(
        Effect.map((saved) => (saved ? outcome : failed("storage-failed"))),
        Effect.tap(() =>
          Effect.sync(() => {
            running.delete(`${entry.device}:${entry.id}`);
          }),
        ),
        Effect.flatMap((answer) => Deferred.succeed(done, answer)),
      );

    const execute = (
      entry: CommandEntry,
      done: Deferred.Deferred<Outcome>,
      apply: Effect.Effect<Outcome>,
      held: Permit | undefined,
    ) =>
      apply.pipe(
        Effect.catchCause(() => Effect.succeed(failed("internal"))),
        Effect.flatMap((outcome) => settle(entry, done, outcome)),
        Effect.interruptible,
        Effect.ensuring(
          Effect.sync(() => {
            held?.release();
          }),
        ),
        Effect.forkIn(executions),
        Effect.as(Deferred.await(done)),
      );

    const begin = (
      entry: CommandEntry,
      apply: Effect.Effect<Outcome>,
      permit: Permit | undefined,
      at: number,
    ): Effect.Effect<Effect.Effect<Outcome>> => {
      let claimed: Claim;
      try {
        claimed = claim(entry, at);
      } catch (error) {
        logger.error("saving a command's id failed, so it didn't run", {
          error: error instanceof Error ? error.name : "unknown",
        });
        return Effect.succeed(Effect.succeed(failed("internal")));
      }
      switch (claimed.type) {
        case "known":
          return Effect.succeed(Effect.succeed(claimed.outcome));
        case "running":
          return Effect.succeed(Deferred.await(claimed.done));
        case "new":
          return execute(entry, claimed.done, apply, permit?.retain());
      }
    };

    const run = (
      entry: CommandEntry,
      apply: Effect.Effect<Outcome>,
      permit?: Permit,
    ) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((at) =>
          Effect.uninterruptible(
            Effect.suspend(() => begin(entry, apply, permit, at)),
          ),
        ),
        Effect.flatten,
      );

    return { run } satisfies CommandLedger;
  });
