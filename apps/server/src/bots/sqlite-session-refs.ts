import { sessionRef } from "@aphelion/plugin-sdk";
import { Clock, Effect, Layer } from "effect";
import type { Database } from "../store";
import { SessionRefs } from "./session-refs";

export const sqliteSessionRefs = (db: Database, serverId: string) =>
  Layer.succeed(
    SessionRefs,
    SessionRefs.of({
      get: (bot) =>
        Effect.sync(() => {
          const row = db.all(
            "SELECT ref, folder FROM bot_sessions WHERE bot = ?",
            [bot],
          )[0];
          const ref = sessionRef.safeParse(row?.["ref"]);
          const folder = row?.["folder"];
          return ref.success && typeof folder === "string"
            ? { ref: ref.data, folder }
            : undefined;
        }),
      set: (bot, { ref, folder }) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Effect.sync(() => {
            db.run(
              `INSERT INTO bot_sessions (bot, folder, ref, server_id, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (bot) DO UPDATE SET
                 folder = excluded.folder,
                 ref = excluded.ref,
                 updated_at = excluded.updated_at`,
              [bot, folder, ref, serverId, now],
            );
          }),
        ),
      clear: (bot) =>
        Effect.sync(() => {
          db.run("DELETE FROM bot_sessions WHERE bot = ?", [bot]);
        }),
    }),
  );
