import {
  runAdapter,
  type BotAdapter,
  type RunAdapterOptions,
} from "@aphelion/plugin-sdk";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
import type { Logger } from "../log";
import { memoryLinkPair, type Framing } from "../plugins/link";
import { SpawnFailed, type ProcessExit } from "../plugins/processes";
import { BotProcesses, type BotProcess, type BotSpec } from "./processes";
import { runBotRunner } from "./runner";
import {
  maxFrameBytes,
  runnerReplySchema,
  runnerRequestSchema,
  type RunnerReply,
  type RunnerRequest,
} from "./runner-protocol";
import { SessionRefs, type SavedSession } from "./session-refs";

export interface FakeBot {
  readonly adapter: () => BotAdapter;
  readonly options?: RunAdapterOptions;
  readonly stopsReading?: boolean;
  readonly launchGate?: Promise<void>;
  readonly refuses?: string;
  readonly floods?: { readonly line: string; pulled: number };
}

export interface FakeRun {
  readonly spec: BotSpec;
  readonly received: { readonly method?: string; readonly params?: unknown }[];
  readonly alive: () => boolean;
  readonly crash: () => void;
  readonly closeStdout: () => void;
  readonly say: (line: string) => void;
}

function inbox() {
  const lines: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  return {
    push(line: string) {
      lines.push(line);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const line = lines.shift();
        if (line !== undefined) {
          yield line;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
}

function pipe() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const readable = new ReadableStream<Uint8Array>({
    start(opened) {
      controller = opened;
    },
  });
  let open = true;
  return {
    stream: Stream.fromReadableStream({
      evaluate: () => readable,
      onError: (error) => error,
    }).pipe(Stream.orDie),
    line: (text: string) => {
      if (open) controller?.enqueue(encoder.encode(`${text}\n`));
    },
    close: () => {
      if (open) controller?.close();
      open = false;
    },
  };
}

const floodLimit = 32 * 1024 * 1024;

function flood(spec: NonNullable<FakeBot["floods"]>) {
  const chunk = new TextEncoder().encode(`${spec.line}\n`.repeat(64));
  let open = true;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const readable = new ReadableStream<Uint8Array>(
    {
      start(opened) {
        controller = opened;
      },
      pull(opened) {
        if (!open || spec.pulled >= floodLimit) return;
        spec.pulled += chunk.byteLength;
        opened.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  return {
    stream: Stream.fromReadableStream({
      evaluate: () => readable,
      onError: (error) => error,
    }).pipe(Stream.orDie),
    line: () => undefined,
    close: () => {
      open = false;
      controller?.close();
    },
  };
}

export function fakeBotProcesses(bots: Readonly<Record<string, FakeBot>>) {
  const runs: FakeRun[] = [];
  const stopAllCalls: string[] = [];

  const launch = (spec: BotSpec, bot: FakeBot): BotProcess => {
    const input = inbox();
    const stdout = bot.floods ? flood(bot.floods) : pipe();
    const stderr = pipe();
    const received: FakeRun["received"] = [];
    let alive = true;
    let resolveExit: (exit: ProcessExit) => void = () => undefined;
    const exited = new Promise<ProcessExit>((resolve) => {
      resolveExit = resolve;
    });
    const end = (exit: ProcessExit) => {
      if (!alive) return;
      alive = false;
      stdout.close();
      stderr.close();
      input.end();
      resolveExit(exit);
    };
    runAdapter(
      bot.adapter(),
      {
        input,
        write: (line) => {
          if (alive) stdout.line(line);
          return Promise.resolve();
        },
        log: (message) => {
          if (alive) stderr.line(message);
        },
      },
      bot.options,
    ).then(
      () => {
        end({ code: 0, signal: null });
      },
      () => {
        end({ code: 1, signal: null });
      },
    );
    const run: FakeRun = {
      spec,
      received,
      alive: () => alive,
      crash: () => {
        end({ code: null, signal: "SIGKILL" });
      },
      closeStdout: () => {
        stdout.close();
      },
      say: (line) => {
        if (alive) stdout.line(line);
      },
    };
    runs.push(run);
    return {
      write: (line) =>
        bot.stopsReading
          ? Effect.never
          : Effect.sync(() => {
              received.push(JSON.parse(line) as FakeRun["received"][number]);
              input.push(line);
            }),
      stdout: stdout.stream,
      stderr: stderr.stream,
      exited: Effect.promise(() => exited),
    };
  };

  const layer = Layer.succeed(BotProcesses, {
    start: (spec) =>
      Effect.gen(function* () {
        const bot = bots[spec.bot];
        if (bot === undefined) {
          return yield* new SpawnFailed({ reason: "no such fake bot" });
        }
        if (bot.refuses !== undefined) {
          return yield* new SpawnFailed({ reason: bot.refuses });
        }
        const gate = bot.launchGate;
        if (gate) yield* Effect.promise(() => gate);
        return launch(spec, bot);
      }),
    stopAll: (bot) =>
      Effect.sync(() => {
        stopAllCalls.push(bot);
        for (const run of runs) if (run.spec.bot === bot) run.crash();
        return { survivors: 0 };
      }),
  });

  const latest = (bot: string) => runs.findLast((run) => run.spec.bot === bot);

  return { layer, runs, stopAllCalls, latest };
}

export const memorySessionRefs = Layer.sync(SessionRefs, () => {
  const saved = new Map<string, SavedSession>();
  return SessionRefs.of({
    get: (bot) => Effect.sync(() => saved.get(bot)),
    set: (bot, session) =>
      Effect.sync(() => {
        saved.set(bot, session);
      }),
    clear: (bot) =>
      Effect.sync(() => {
        saved.delete(bot);
      }),
  });
});

const framing = <T>(schema: Framing<T>["schema"]): Framing<T> => ({
  schema,
  maxBytes: maxFrameBytes,
  onDrop: () => Effect.void,
});

export const fakeRunnerLink = (
  fake: ReturnType<typeof fakeBotProcesses>,
  logger: Logger,
) =>
  Effect.gen(function* () {
    const { a, b } = yield* memoryLinkPair<RunnerReply, RunnerRequest>(
      framing(runnerReplySchema),
      framing(runnerRequestSchema),
    );
    const runnerScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(runnerScope, Exit.void));
    yield* runBotRunner(b, {
      home: "/var/lib/aphelion-bots",
      shutdownGrace: "200 millis",
      writeDeadline: "1 second",
      logger,
    }).pipe(
      Effect.provide(fake.layer),
      Scope.provide(runnerScope),
      Effect.forkIn(runnerScope),
    );
    return a;
  });
