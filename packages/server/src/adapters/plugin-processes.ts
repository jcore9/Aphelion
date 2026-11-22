import { dlopen, FFIType } from "bun:ffi";
import { readdirSync, readFileSync } from "node:fs";
import {
  access,
  constants,
  lstat,
  mkdir,
  readdir,
  realpath,
} from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { Effect, Layer, Stream } from "effect";
import {
  PluginProcesses,
  SpawnFailed,
  type PluginProcess,
  type SpawnSpec,
} from "../plugins/processes";

const PR_SET_DUMPABLE = 4;
const PR_SET_CHILD_SUBREAPER = 36;
const WNOHANG = 1;
const STICKY = 0o1000;

const libc = () =>
  dlopen("libc.so.6", {
    prctl: {
      args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
      returns: FFIType.i32,
    },
    waitpid: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
  }).symbols;

interface Proc {
  readonly pid: number;
  readonly parent: number;
  readonly started: string;
}

function read(pid: number): Proc | undefined {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, parent: Number(fields[1]), started: fields[19] ?? "" };
  } catch {
    return undefined;
  }
}

const isStill = (proc: Proc) => read(proc.pid)?.started === proc.started;
const identity = (proc: Proc) => `${String(proc.pid)}:${proc.started}`;

function childrenByParent(): Map<number, Proc[]> {
  const children = new Map<number, Proc[]>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const proc = read(Number(name));
    if (proc === undefined) continue;
    const siblings = children.get(proc.parent) ?? [];
    siblings.push(proc);
    children.set(proc.parent, siblings);
  }
  return children;
}

function treeOf(roots: readonly Proc[]): Proc[] {
  const children = childrenByParent();
  const tree: Proc[] = [];
  const queue = [...roots];
  for (let proc = queue.pop(); proc !== undefined; proc = queue.pop()) {
    tree.push(proc);
    queue.push(...(children.get(proc.pid) ?? []));
  }
  return tree;
}

function signal(proc: Proc, name: "SIGSTOP" | "SIGKILL"): void {
  if (!isStill(proc)) return;
  try {
    process.kill(proc.pid, name);
  } catch {
    return;
  }
}

function freezeAndKill(roots: () => Proc[]): Proc[] {
  const frozen = new Map<string, Proc>();
  for (;;) {
    const fresh = treeOf(roots()).filter((proc) => !frozen.has(identity(proc)));
    if (fresh.length === 0) break;
    for (const proc of fresh) {
      signal(proc, "SIGSTOP");
      frozen.set(identity(proc), proc);
    }
  }
  for (const proc of frozen.values()) signal(proc, "SIGKILL");
  return [...frozen.values()];
}

const inside = (root: string, path: string) => path.startsWith(root + sep);

async function installProblem(
  installRoot: string,
  pluginUid: number,
): Promise<string | undefined> {
  const visit = async (path: string): Promise<string | undefined> => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = await realpath(path).catch(() => undefined);
      return target !== undefined && inside(installRoot, target)
        ? undefined
        : "a link in the plugin's folder points outside it";
    }
    if (info.uid === pluginUid) {
      return "the plugin user owns a file in the plugin's folder";
    }
    const writable = await access(path, constants.W_OK).then(
      () => true,
      () => false,
    );
    if (writable) return "the plugin user can write to the plugin's folder";
    if (!info.isDirectory()) return undefined;
    for (const name of await readdir(path)) {
      const problem = await visit(join(path, name));
      if (problem !== undefined) return problem;
    }
    return undefined;
  };
  return visit(installRoot);
}

async function ancestorProblem(
  installRoot: string,
  pluginUid: number,
): Promise<string | undefined> {
  for (let path = dirname(installRoot); ; path = dirname(path)) {
    const info = await lstat(path);
    const writable = await access(path, constants.W_OK).then(
      () => true,
      () => false,
    );
    const sticky = (info.mode & STICKY) !== 0;
    if (info.uid === pluginUid || (writable && !sticky)) {
      return "the plugin user can change a folder above the plugin's folder";
    }
    if (path === dirname(path)) return undefined;
  }
}

export const bunPluginProcesses = (runtime: string, pluginUid: number) =>
  Layer.effect(
    PluginProcesses,
    Effect.gen(function* () {
      const { prctl, waitpid } = libc();
      if (prctl(PR_SET_CHILD_SUBREAPER, 1n, 0n, 0n, 0n) !== 0) {
        return yield* Effect.die(
          new Error("the plugin runner couldn't become a child subreaper"),
        );
      }
      if (prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n) !== 0) {
        return yield* Effect.die(
          new Error("the plugin runner couldn't hide its memory and pipes"),
        );
      }
      const roots = new Set<number>();
      const orphans = () =>
        (childrenByParent().get(process.pid) ?? []).filter(
          (proc) => !roots.has(proc.pid),
        );

      const reap = (killed: readonly Proc[]) =>
        Effect.gen(function* () {
          const waiting = new Set(killed);
          for (let tries = 0; waiting.size > 0 && tries < 200; tries++) {
            for (const proc of waiting) {
              if (
                waitpid(proc.pid, null, WNOHANG) === proc.pid ||
                !isStill(proc)
              ) {
                waiting.delete(proc);
              }
            }
            if (waiting.size > 0) yield* Effect.sleep("10 millis");
          }
          return { survivors: waiting.size };
        });

      const sweep = Effect.suspend(() => reap(freezeAndKill(orphans)));

      const spawn = (spec: SpawnSpec) =>
        Effect.gen(function* () {
          const fail = (reason: string) => new SpawnFailed({ reason });
          const folder = yield* Effect.tryPromise({
            try: () => realpath(spec.folder),
            catch: () => fail("the plugin's folder can't be read"),
          });
          const entry = yield* Effect.tryPromise({
            try: () => realpath(join(folder, spec.entry)),
            catch: () => fail("the plugin's entry file can't be found"),
          });
          if (!inside(folder, entry)) {
            return yield* fail("the entry is outside the plugin's folder");
          }
          const problem = yield* Effect.tryPromise({
            try: async () =>
              (await installProblem(folder, pluginUid)) ??
              (await ancestorProblem(folder, pluginUid)),
            catch: () => fail("the plugin's folder can't be read"),
          });
          if (problem !== undefined) return yield* fail(problem);
          yield* Effect.tryPromise({
            try: () => mkdir(spec.dataFolder, { recursive: true, mode: 0o700 }),
            catch: () => fail("the plugin's data folder can't be created"),
          });
          const child = yield* Effect.try({
            try: () =>
              Bun.spawn([runtime, "--no-env-file", entry], {
                cwd: folder,
                env: { ...spec.env },
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe",
              }),
            catch: () => fail("bun couldn't be started"),
          });
          roots.add(child.pid);
          const ended = child.exited.then(() => roots.delete(child.pid));
          const bytes = (stream: ReadableStream<Uint8Array>) =>
            Stream.fromReadableStream({
              evaluate: () => stream,
              onError: (error) => error,
            }).pipe(Stream.orDie);
          const alive = () =>
            child.exitCode === null && child.signalCode === null;
          const self = (): Proc[] => {
            const proc = alive() ? read(child.pid) : undefined;
            return proc ? [proc] : [];
          };

          return {
            write: (line) =>
              Effect.tryPromise(async () => {
                await child.stdin.write(`${line}\n`);
                await child.stdin.flush();
              }).pipe(Effect.ignore),
            stdout: bytes(child.stdout),
            stderr: bytes(child.stderr),
            exited: Effect.promise(() => ended).pipe(
              Effect.map(() => ({
                code: child.exitCode,
                signal:
                  child.signalCode === null ? null : String(child.signalCode),
              })),
            ),
            kill: Effect.gen(function* () {
              const killed = freezeAndKill(() => [...self(), ...orphans()]);
              const cleanup = yield* reap(
                killed.filter((proc) => proc.pid !== child.pid),
              );
              const exited = yield* Effect.promise(() => ended).pipe(
                Effect.timeout("5 seconds"),
                Effect.option,
              );
              return {
                survivors: cleanup.survivors + (exited._tag === "None" ? 1 : 0),
              };
            }),
          } satisfies PluginProcess;
        });

      return PluginProcesses.of({ spawn, sweep });
    }),
  );
