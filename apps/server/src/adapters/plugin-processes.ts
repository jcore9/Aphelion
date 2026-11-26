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
  type Interruptibly,
  type PluginProcess,
  type SpawnSpec,
} from "../plugins/processes";
import {
  childrenByParent,
  freezeAndKill,
  isStill,
  libc,
  PR_SET_CHILD_SUBREAPER,
  PR_SET_DUMPABLE,
  read,
  type Proc,
} from "./process-tree";

const WNOHANG = 1;
const STICKY = 0o1000;

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

      const spawn = (spec: SpawnSpec, interruptibly: Interruptibly) =>
        Effect.gen(function* () {
          const fail = (reason: string) => new SpawnFailed({ reason });
          const folder = yield* interruptibly(
            Effect.tryPromise({
              try: () => realpath(spec.folder),
              catch: () => fail("the plugin's folder can't be read"),
            }),
          );
          const entry = yield* interruptibly(
            Effect.tryPromise({
              try: () => realpath(join(folder, spec.entry)),
              catch: () => fail("the plugin's entry file can't be found"),
            }),
          );
          if (!inside(folder, entry)) {
            return yield* fail("the entry is outside the plugin's folder");
          }
          const problem = yield* interruptibly(
            Effect.tryPromise({
              try: async () =>
                (await installProblem(folder, pluginUid)) ??
                (await ancestorProblem(folder, pluginUid)),
              catch: () => fail("the plugin's folder can't be read"),
            }),
          );
          if (problem !== undefined) return yield* fail(problem);
          yield* interruptibly(
            Effect.tryPromise({
              try: () =>
                mkdir(spec.dataFolder, { recursive: true, mode: 0o700 }),
              catch: () => fail("the plugin's data folder can't be created"),
            }),
          );
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
