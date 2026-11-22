import { dlopen, FFIType } from "bun:ffi";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { access, constants, lstat, mkdir, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Effect, Layer, Stream } from "effect";
import {
  PluginProcesses,
  SpawnFailed,
  type PluginProcess,
  type SpawnSpec,
} from "../plugins/processes";

const PR_SET_CHILD_SUBREAPER = 36;
const WNOHANG = 1;

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

function parentOf(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return undefined;
  }
}

function childrenByParent(): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const parent = parentOf(pid);
    if (parent === undefined) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(pid);
    children.set(parent, siblings);
  }
  return children;
}

function treeOf(roots: readonly number[]): number[] {
  const children = childrenByParent();
  const tree: number[] = [];
  const queue = [...roots];
  for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
    tree.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return tree;
}

function signal(pid: number, name: "SIGSTOP" | "SIGKILL"): void {
  try {
    process.kill(pid, name);
  } catch {
    return;
  }
}

function freezeAndKill(roots: () => number[]): Set<number> {
  const frozen = new Set<number>();
  for (;;) {
    const fresh = treeOf(roots()).filter((pid) => !frozen.has(pid));
    if (fresh.length === 0) break;
    for (const pid of fresh) {
      signal(pid, "SIGSTOP");
      frozen.add(pid);
    }
  }
  for (const pid of frozen) signal(pid, "SIGKILL");
  return frozen;
}

async function firstWritable(path: string): Promise<string | undefined> {
  const writable = await access(path, constants.W_OK).then(
    () => true,
    () => false,
  );
  if (writable) return path;
  const info = await lstat(path);
  if (!info.isDirectory()) return undefined;
  for (const name of await readdir(path)) {
    const found = await firstWritable(join(path, name));
    if (found !== undefined) return found;
  }
  return undefined;
}

export const bunPluginProcesses = (runtime: string) =>
  Layer.effect(
    PluginProcesses,
    Effect.gen(function* () {
      const { prctl, waitpid } = libc();
      if (prctl(PR_SET_CHILD_SUBREAPER, 1n, 0n, 0n, 0n) !== 0) {
        return yield* Effect.die(
          new Error("the plugin runner couldn't become a child subreaper"),
        );
      }
      const roots = new Set<number>();
      const orphans = () =>
        (childrenByParent().get(process.pid) ?? []).filter(
          (pid) => !roots.has(pid),
        );

      const reap = (killed: Set<number>) =>
        Effect.gen(function* () {
          const waiting = new Set(killed);
          for (let tries = 0; waiting.size > 0 && tries < 200; tries++) {
            for (const pid of waiting) {
              if (
                waitpid(pid, null, WNOHANG) === pid ||
                !existsSync(`/proc/${String(pid)}`)
              ) {
                waiting.delete(pid);
              }
            }
            if (waiting.size > 0) yield* Effect.sleep("10 millis");
          }
        });

      const sweep = Effect.suspend(() => reap(freezeAndKill(orphans)));

      const spawn = (spec: SpawnSpec) =>
        Effect.gen(function* () {
          const fail = (reason: string) => new SpawnFailed({ reason });
          const folder = resolve(spec.folder);
          const entry = resolve(folder, spec.entry);
          if (!entry.startsWith(folder + sep)) {
            return yield* fail("the entry is outside the plugin's folder");
          }
          const writable = yield* Effect.tryPromise({
            try: () => firstWritable(folder),
            catch: () => fail("the plugin's folder can't be read"),
          });
          if (writable !== undefined) {
            return yield* fail(
              "the plugin user can write to the plugin's folder",
            );
          }
          yield* Effect.tryPromise({
            try: () => mkdir(spec.dataFolder, { recursive: true, mode: 0o700 }),
            catch: () => fail("the plugin's data folder can't be created"),
          });
          const child = yield* Effect.try({
            try: () =>
              Bun.spawn([runtime, entry], {
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
              const killed = freezeAndKill(() => [
                ...(alive() ? [child.pid] : []),
                ...orphans(),
              ]);
              killed.delete(child.pid);
              yield* reap(killed);
              yield* Effect.promise(() => ended);
            }),
          } satisfies PluginProcess;
        });

      return PluginProcesses.of({ spawn, sweep });
    }),
  );
