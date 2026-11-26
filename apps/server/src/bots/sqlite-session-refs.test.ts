import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionRef } from "@aphelion/plugin-sdk";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { onTestFinished } from "vitest";
import { openStore, readServerId } from "../store";
import { SessionRefs } from "./session-refs";
import { sqliteSessionRefs } from "./sqlite-session-refs";

const withRefs = (path: string) =>
  Effect.gen(function* () {
    const db = openStore(path);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        db.close();
      }),
    );
    const services = yield* Layer.build(
      sqliteSessionRefs(db, readServerId(db)),
    );
    return { db, refs: Context.get(services, SessionRefs) };
  });

const tempPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "aphelion-session-refs-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true });
  });
  return join(dir, "aphelion.db");
};

const ref = (value: string) => sessionRef.parse(value);

it.effect("saves a session per bot, replaces it, and clears it", () =>
  Effect.gen(function* () {
    const { refs, db } = yield* withRefs(tempPath());
    expect(yield* refs.get("chief")).toBeUndefined();

    yield* refs.set("chief", { ref: ref("s-1"), folder: "/bots/chief" });
    yield* refs.set("scout", { ref: ref("s-9"), folder: "/bots/scout" });
    yield* refs.set("chief", { ref: ref("s-2"), folder: "/bots/chief" });

    expect(yield* refs.get("chief")).toEqual({
      ref: "s-2",
      folder: "/bots/chief",
    });
    expect(yield* refs.get("scout")).toEqual({
      ref: "s-9",
      folder: "/bots/scout",
    });
    expect(
      db.all("SELECT bot, server_id FROM bot_sessions ORDER BY bot"),
    ).toEqual([
      { bot: "chief", server_id: readServerId(db) },
      { bot: "scout", server_id: readServerId(db) },
    ]);

    yield* refs.clear("chief");
    expect(yield* refs.get("chief")).toBeUndefined();
    expect(yield* refs.get("scout")).toBeDefined();
  }).pipe(Effect.scoped),
);

it.effect("keeps a saved session across a restart", () =>
  Effect.gen(function* () {
    const path = tempPath();
    yield* Effect.gen(function* () {
      const { refs } = yield* withRefs(path);
      yield* refs.set("chief", { ref: ref("s-1"), folder: "/bots/chief" });
    }).pipe(Effect.scoped);

    const { refs } = yield* withRefs(path);

    expect(yield* refs.get("chief")).toEqual({
      ref: "s-1",
      folder: "/bots/chief",
    });
  }).pipe(Effect.scoped),
);

it.effect("treats a saved session that is no longer a valid ref as none", () =>
  Effect.gen(function* () {
    const { refs, db } = yield* withRefs(tempPath());
    db.run(
      "INSERT INTO bot_sessions (bot, folder, ref, server_id, updated_at) VALUES ('chief', '/bots/chief', 'has a space', ?, 0)",
      [readServerId(db)],
    );

    expect(yield* refs.get("chief")).toBeUndefined();
  }).pipe(Effect.scoped),
);
