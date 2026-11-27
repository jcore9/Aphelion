import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, streamId } from "@aphelion/protocol";
import { expect, it } from "@effect/vitest";
import { Deferred, Duration, Effect } from "effect";
import { Socket } from "effect/socket";
import { onTestFinished } from "vitest";
import { openEventStore } from "../history";
import { createLogger } from "../log";
import { openStore, readServerId } from "../store";
import { closeReasons, serveSocket } from "./socket";

const fakeClient = (resume: string, slow: boolean) =>
  Effect.gen(function* () {
    const written: (string | Socket.CloseEvent)[] = [];
    const stuck = yield* Deferred.make<undefined>();
    const sent = yield* Deferred.make<undefined>();
    let resumed = false;
    const socket = Socket.make({
      reader: Effect.succeed({
        pull: Effect.suspend(() => {
          if (resumed) return Effect.never;
          resumed = true;
          return Effect.succeed([resume] as const);
        }),
        upgrade: () => Effect.void,
      }),
      writer: Effect.succeed({
        write: (chunk: string | Uint8Array | Socket.CloseEvent) =>
          Effect.gen(function* () {
            if (typeof chunk === "string") {
              if (slow) yield* Deferred.await(stuck);
              written.push(chunk);
            } else if (Socket.isCloseEvent(chunk)) {
              written.push(chunk);
              yield* Deferred.succeed(sent, undefined);
            }
          }),
        writeAll: () => Effect.void,
      }),
    });
    return { socket, written, closed: Deferred.await(sent) };
  });

it.effect(
  "closes a client that falls too far behind and keeps serving the others",
  () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "aphelion-slow-"));
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
      yield* store.openTurn("chief", "t1");
      const resume = encodeFrame({
        v: 1,
        type: "resume",
        cursor: { stream: streamId.parse(store.streamId), seq: 0 },
      });
      const slow = yield* fakeClient(resume, true);
      const fast = yield* fakeClient(resume, false);
      const limit = 3;
      for (const client of [slow, fast]) {
        yield* Effect.forkScoped(
          serveSocket(
            client.socket,
            Effect.succeed(true),
            Duration.seconds(30),
            store,
            () => Effect.die("no command was sent"),
            limit,
          ),
        );
      }
      yield* Effect.repeat(Effect.yieldNow, { times: 20 });

      yield* store.appendNow(
        Array.from({ length: limit + 3 }, (_, i) => ({
          bot: "chief",
          run: 1,
          turn: "t1",
          event: { type: "text.delta" as const, text: `m${String(i)}` },
        })),
      );
      yield* slow.closed;
      yield* Effect.repeat(Effect.yieldNow, {
        until: () => fast.written.length === limit + 3,
      });

      expect(slow.written.at(-1)).toEqual(closeReasons.tooSlow);
      expect(fast.written).toHaveLength(limit + 3);
      expect(fast.written.some((item) => typeof item !== "string")).toBe(false);
    }).pipe(Effect.scoped),
);
