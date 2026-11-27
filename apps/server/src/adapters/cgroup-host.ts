import {
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import type { Logger } from "../log";
import {
  CgroupHost,
  HostFailed,
  type AdapterEntry,
  type RunPaths,
  type SupervisedChild,
} from "../cgroups/supervisor";
import { connectRun, type RunPipes } from "./run-fifos";

export interface BunCgroupHostOptions {
  readonly mount: string;
  readonly tree: string;
  readonly runs: string;
  readonly entry: string;
  readonly botUid: number;
  readonly logger: Logger;
}

export const shippedCgroupHost = {
  mount: "/sys/fs/cgroup",
  tree: "bots",
  runs: "/run/aphelion-runs",
  entry: "/usr/local/lib/aphelion/run-adapter",
  botUid: 10002,
} as const;

const errnoOf = (error: unknown) =>
  (error as NodeJS.ErrnoException).code ?? "unknown";

const attempt = <A>(step: string, run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) => new HostFailed({ step, errno: errnoOf(error) }),
  });

const failed = (step: string, errno: string) =>
  Effect.fail(new HostFailed({ step, errno }));

const statusOf = (pid: number) => {
  try {
    return readFileSync(`/proc/${String(pid)}/status`, "utf8");
  } catch {
    return undefined;
  }
};

const field = (status: string, name: string) =>
  status
    .split("\n")
    .find((line) => line.startsWith(`${name}:`))
    ?.slice(name.length + 1)
    .trim()
    .split(/\s+/)
    .filter((part) => part !== "") ?? [];

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    const end = text.indexOf("\n");
    if (end >= 0) return text.slice(0, end);
  }
  return text;
}

export const bunCgroupHost = (options: BunCgroupHostOptions) =>
  Layer.sync(CgroupHost, () => {
    const tree = join(options.mount, options.tree);
    const probes = new Map<string, RunPipes>();

    const removeRun = (paths: RunPaths) =>
      Effect.gen(function* () {
        yield* attempt("remove-folder", () => {
          rmSync(paths.folder, { recursive: true, force: true });
        });
        for (let tries = 0; ; tries++) {
          const removed = yield* Effect.result(
            attempt("remove-leaf", () => {
              if (existsSync(paths.leaf)) rmdirSync(paths.leaf);
            }),
          );
          if (removed._tag === "Success") return;
          if (tries >= 50) return yield* Effect.fail(removed.failure);
          yield* Effect.sleep("20 millis");
        }
      });

    const makeRun = (run: string) =>
      Effect.gen(function* () {
        const folder = join(options.runs, run);
        const paths: RunPaths = {
          leaf: join(tree, "work", run),
          folder,
          stdin: join(folder, "stdin"),
          stdout: join(folder, "stdout"),
          stderr: join(folder, "stderr"),
        };
        yield* attempt("make-leaf", () => {
          mkdirSync(paths.leaf);
        });
        yield* Effect.gen(function* () {
          const group = yield* attempt("make-folder", () => {
            const { gid } = statSync(options.runs);
            mkdirSync(folder, { mode: 0o750 });
            chownSync(folder, -1, gid);
            return gid;
          });
          const made = Bun.spawnSync(
            [
              "/usr/bin/mkfifo",
              "-m",
              "0660",
              paths.stdin,
              paths.stdout,
              paths.stderr,
            ],
            { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
          );
          if (made.exitCode !== 0) return yield* failed("make-fifos", "mkfifo");
          yield* attempt("make-fifos", () => {
            for (const fifo of [paths.stdin, paths.stdout, paths.stderr]) {
              chownSync(fifo, -1, group);
            }
          });
        }).pipe(Effect.tapError(() => Effect.ignore(removeRun(paths))));
        return paths;
      });

    const spawn = (paths: RunPaths, entry: AdapterEntry, bot: string) =>
      attempt("spawn", () =>
        Bun.spawn(
          [options.entry, paths.leaf, paths.folder, entry.bundle, bot],
          {
            cwd: "/",
            env: { ...entry.env },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
          },
        ),
      ).pipe(
        Effect.map((child): SupervisedChild => {
          const exited = child.exited.then(() => ({
            code: child.exitCode,
            signal: child.signalCode === null ? null : String(child.signalCode),
          }));
          const placed = firstLine(child.stdout).then(
            (line) => line === "placed",
            () => false,
          );
          return {
            pid: child.pid,
            placed: Effect.promise(() => placed),
            exited: Effect.promise(() => exited),
            abort: Effect.sync(() => {
              child.kill("SIGKILL");
            }),
          };
        }),
      );

    const kill = (paths: RunPaths) =>
      Effect.gen(function* () {
        yield* attempt("cgroup.kill", () => {
          writeFileSync(join(paths.leaf, "cgroup.kill"), "1");
        });
        for (let tries = 0; tries < 500; tries++) {
          const events = yield* attempt("cgroup.events", () =>
            readFileSync(join(paths.leaf, "cgroup.events"), "utf8"),
          );
          if (/^populated 0$/m.test(events)) return;
          yield* Effect.sleep("10 millis");
        }
        return yield* failed("populated", "ETIMEDOUT");
      });

    const ownCgroup = Effect.gen(function* () {
      const own = yield* attempt("own-cgroup", () =>
        readFileSync("/proc/self/cgroup", "utf8"),
      );
      if (own.trim() !== `0::/${options.tree}/system/supervisor`) {
        return yield* failed("own-cgroup", "ENOENT");
      }
    });

    const placed = (paths: RunPaths, pid: number) =>
      Effect.gen(function* () {
        const listed = yield* attempt("placed", () =>
          readFileSync(join(paths.leaf, "cgroup.procs"), "utf8"),
        );
        if (!listed.split("\n").includes(String(pid))) {
          return yield* failed("placed", "ESRCH");
        }
      });

    const dropped = (paths: RunPaths, pid: number) =>
      Effect.gen(function* () {
        const pipes = yield* Effect.tryPromise({
          try: () => connectRun(paths, 5_000, () => undefined),
          catch: (error) =>
            new HostFailed({ step: "drop", errno: errnoOf(error) }),
        });
        probes.set(paths.folder, pipes);
        const uid = String(options.botUid);
        let status = statusOf(pid);
        for (let tries = 0; tries < 500; tries++) {
          if (status === undefined) return yield* failed("drop", "ESRCH");
          if (field(status, "Uid")[0] === uid) break;
          yield* Effect.sleep("10 millis");
          status = statusOf(pid);
        }
        if (status === undefined) return yield* failed("drop", "ESRCH");
        const same = (values: readonly string[]) =>
          values.length === 4 && values.every((value) => value === uid);
        const zero = (name: string) =>
          /^0+$/.test(field(status, name)[0] ?? "");
        if (!same(field(status, "Uid")) || !same(field(status, "Gid"))) {
          return yield* failed("drop", "EUID");
        }
        if (field(status, "Groups").length > 0) {
          return yield* failed("drop", "EGROUPS");
        }
        if (!["CapInh", "CapPrm", "CapEff", "CapAmb"].every(zero)) {
          return yield* failed("drop", "ECAPS");
        }
        if (field(status, "NoNewPrivs")[0] !== "1") {
          return yield* failed("drop", "ENONEWPRIVS");
        }
      });

    const botDenied = (paths: RunPaths) =>
      Effect.gen(function* () {
        const pipes = probes.get(paths.folder);
        if (pipes === undefined) return yield* failed("bot-denied", "EPIPE");
        const answer = yield* Effect.tryPromise({
          try: async () => {
            await pipes.write(
              `${JSON.stringify({
                tree,
                folder: paths.folder,
                fifos: [paths.stdin, paths.stdout, paths.stderr],
              })}\n`,
            );
            return JSON.parse(await firstLine(pipes.stdout)) as {
              readonly allowed: readonly string[];
            };
          },
          catch: () => new HostFailed({ step: "bot-denied", errno: "EPROTO" }),
        }).pipe(
          Effect.timeout("10 seconds"),
          Effect.catchTag("TimeoutError", () =>
            failed("bot-denied", "ETIMEDOUT"),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              pipes.close();
              probes.delete(paths.folder);
            }),
          ),
        );
        if (answer.allowed.length > 0) {
          options.logger.error(
            "an aphelion-bot process reached the cgroup tree",
            {
              allowed: answer.allowed.slice(0, 20),
            },
          );
          return yield* failed("bot-denied", "ok");
        }
      });

    const gone = (paths: RunPaths, pid: number) =>
      Effect.gen(function* () {
        if (statusOf(pid) !== undefined) return yield* failed("gone", "EALIVE");
        if (existsSync(paths.leaf) || existsSync(paths.folder)) {
          return yield* failed("gone", "EEXIST");
        }
      });

    return CgroupHost.of({
      makeRun,
      spawn,
      kill,
      removeRun,
      probe: { ownCgroup, placed, dropped, botDenied, gone },
    });
  });
