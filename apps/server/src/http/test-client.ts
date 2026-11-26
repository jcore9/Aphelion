import {
  encodeFrame,
  parseServerFrame,
  type ServerFrame,
} from "@aphelion/protocol";
import { Effect } from "effect";
import type { CommandServices } from "../commands";
import { createLogger } from "../log";

export const idleCommands: CommandServices = {
  bots: undefined,
  ledger: { run: (_entry, apply) => apply },
  logger: createLogger({ write: () => undefined }),
};

export interface Client {
  readonly frames: ServerFrame[];
  readonly send: (frame: Parameters<typeof encodeFrame>[0]) => void;
  readonly close: () => void;
  readonly closeCode: Effect.Effect<number>;
  readonly until: (count: number) => Effect.Effect<readonly ServerFrame[]>;
}

export const connectClient = (url: string, bearer: string) =>
  Effect.promise(
    () =>
      new Promise<Client>((resolve, reject) => {
        const socket = new WebSocket(`${url.replace(/^http/, "ws")}/ws`, {
          headers: { authorization: `Bearer ${bearer}` },
        });
        const frames: ServerFrame[] = [];
        let wake: (() => void) | undefined;
        const closed = Promise.withResolvers<number>();
        socket.addEventListener("message", ({ data }) => {
          const parsed = parseServerFrame(String(data));
          if (!parsed.ok) throw new Error(parsed.error.message);
          frames.push(parsed.frame);
          wake?.();
        });
        socket.addEventListener("close", ({ code }) => {
          closed.resolve(code);
        });
        socket.addEventListener("error", () => {
          reject(new Error("the socket failed to open"));
        });
        socket.addEventListener("open", () => {
          resolve({
            frames,
            send: (frame) => {
              socket.send(encodeFrame(frame));
            },
            close: () => {
              socket.close();
            },
            closeCode: Effect.promise(() => closed.promise).pipe(
              Effect.timeout("5 seconds"),
              Effect.orDie,
            ),
            until: (count) =>
              Effect.promise(
                () =>
                  new Promise<readonly ServerFrame[]>((done) => {
                    const check = () => {
                      if (frames.length >= count) done(frames.slice(0, count));
                    };
                    wake = check;
                    check();
                  }),
              ).pipe(Effect.timeout("5 seconds"), Effect.orDie),
          });
        });
      }),
  );
