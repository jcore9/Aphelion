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
            "SELECT ref, folder, provider FROM bot_sessions WHERE server_id = ? AND bot = ?",
            [serverId, bot],
          )[0];
          const ref = sessionRef.safeParse(row?.["ref"]);
          const folder = row?.["folder"];
          const provider = row?.["provider"];
          return ref.success &&
            typeof folder === "string" &&
            typeof provider === "string"
            ? { ref: ref.data, folder, provider }
            : undefined;
        }),
      set: (bot, { ref, folder, provider }) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Effect.sync(() => {
            db.run(
              `INSERT INTO bot_sessions (server_id, bot, folder, provider, ref, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (server_id, bot) DO UPDATE SET
                 folder = excluded.folder,
                 provider = excluded.provider,
                 ref = excluded.ref,
                 updated_at = excluded.updated_at`,
              [serverId, bot, folder, provider, ref, now],
            );
          }),
        ),
      clear: (bot) =>
        Effect.sync(() => {
          db.run("DELETE FROM bot_sessions WHERE server_id = ? AND bot = ?", [
            serverId,
            bot,
          ]);
        }),
    }),
  );
