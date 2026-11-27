import { spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Fiber, Layer, Queue } from "effect";
import { afterEach, describe } from "vitest";
import { CliFailure } from "../cli/failure";
import { botRunnerChannelFailedMessage, headless } from "../cli/headless";
import { createLogger } from "../log";
import { BotRunnerLink } from "./manager";
import { botRunnerPipeLink } from "./runner-pipe";

const example = join(
  import.meta.dirname,
  "../../../../docs/reference/config/example",
);

const folders: string[] = [];
const opened: number[] = [];

afterEach(async () => {
  for (const fd of opened.splice(0)) {
    try {
      closeSync(fd);
    } catch {
      continue;
    }
  }
  for (const folder of folders.splice(0)) {
    await rm(folder, { recursive: true, force: true });
  }
});

const fifo = (folder: string, name: string) => {
  const path = join(folder, name);
  spawnSync("mkfifo", ["-m", "0600", path]);
  const hold = openSync(path, "r+");
  const reader = openSync(path, "r");
  const writer = openSync(path, "w");
  closeSync(hold);
  opened.push(reader, writer);
  return { reader, writer };
};

const forget = (fd: number) => {
  const index = opened.indexOf(fd);
  if (index !== -1) opened.splice(index, 1);
};

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address !== null) {
          resolve(address.port);
        } else {
          reject(new Error("no port"));
        }
      });
    });
  });

describe.skipIf(process.platform !== "linux")(
  "the bot runner pipe link",
  () => {
    it.live("closes the channel and ends incoming when torn down", () =>
      Effect.gen(function* () {
        const folder = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "aphelion-bot-pipe-")),
        );
        folders.push(folder);
        const replies = fifo(folder, "replies");
        const requests = fifo(folder, "requests");
        const logger = createLogger({ write: () => undefined });
        const services = yield* Layer.build(
          botRunnerPipeLink(
            { replies: replies.reader, requests: requests.writer },
            logger,
          ),
        );
        const link = Context.get(services, BotRunnerLink);

        expect(link.close).toBeDefined();
        if (link.close !== undefined) yield* link.close;
        forget(requests.writer);

        const exit = yield* Queue.take(link.incoming).pipe(
          Effect.exit,
          Effect.timeout("1 second"),
          Effect.orDie,
        );
        expect(
          Exit.isFailure(exit) && Cause.isDone(Cause.squash(exit.cause)),
        ).toBe(true);
      }).pipe(Effect.scoped),
    );

    it.live(
      "stops headless with exit code 1 and one fixed error line when the bot runner channel fails",
      () =>
        Effect.gen(function* () {
          const folder = yield* Effect.promise(() =>
            mkdtemp(join(tmpdir(), "aphelion-headless-bot-pipe-")),
          );
          folders.push(folder);
          const configDir = join(folder, "etc");
          const stateDir = join(folder, "state");
          const port = yield* Effect.promise(freePort);
          yield* Effect.promise(async () => {
            await cp(example, configDir, { recursive: true });
            await writeFile(
              join(configDir, "server.yaml"),
              `version: 1\naddress: 127.0.0.1\nport: ${String(port)}\n`,
            );
            await chmod(configDir, 0o750);
            for (const file of await readdir(configDir)) {
              await chmod(join(configDir, file), 0o640);
            }
            await mkdir(stateDir, { mode: 0o700 });
            await chmod(stateDir, 0o700);
          });
          const replies = fifo(folder, "replies");
          const requests = fifo(folder, "requests");
          const logs: Record<string, unknown>[] = [];
          const logger = createLogger({
            write: (line) =>
              logs.push(JSON.parse(line) as Record<string, unknown>),
          });

          const running = yield* headless(
            {
              configDir,
              stateDir,
              pluginRunnerFds: undefined,
              botRunnerFds: {
                replies: replies.reader,
                requests: requests.writer,
              },
              pluginDev: undefined,
            },
            logger,
          ).pipe(Effect.exit, Effect.forkScoped);

          for (let tries = 0; tries < 200; tries++) {
            if (logs.some((entry) => entry["msg"] === "server started")) break;
            yield* Effect.sleep("25 millis");
          }
          expect(logs.some((entry) => entry["msg"] === "server started")).toBe(
            true,
          );

          closeSync(replies.writer);
          forget(replies.writer);
          forget(requests.writer);

          const exit = yield* Fiber.join(running).pipe(
            Effect.timeout("5 seconds"),
            Effect.orDie,
          );
          expect(Exit.isFailure(exit)).toBe(true);
          const error = Exit.isFailure(exit)
            ? Cause.squash(exit.cause)
            : undefined;
          expect(error).toBeInstanceOf(CliFailure);
          expect((error as CliFailure).exitCode).toBe(1);
          expect(
            logs.some(
              (entry) =>
                entry["level"] === "error" &&
                entry["msg"] === botRunnerChannelFailedMessage,
            ),
          ).toBe(true);
        }).pipe(Effect.scoped),
      15_000,
    );
  },
);
