import {
  runAdapter,
  type BotAdapter,
  type RunAdapterOptions,
} from "@aphelion/plugin-sdk";
import { Effect, Layer, Stream } from "effect";
import { SpawnFailed, type ProcessExit } from "../plugins/processes";
import { BotProcesses, type BotProcess, type BotSpec } from "./processes";

export interface FakeBot {
  readonly adapter: () => BotAdapter;
  readonly options?: RunAdapterOptions;
  readonly stopsReading?: boolean;
  readonly launchGate?: Promise<void>;
  readonly refuses?: string;
}

export interface FakeRun {
  readonly spec: BotSpec;
  readonly received: { readonly method?: string; readonly params?: unknown }[];
  readonly alive: () => boolean;
  readonly crash: () => void;
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
  return {
    stream: Stream.fromReadableStream({
      evaluate: () => readable,
      onError: (error) => error,
    }).pipe(Stream.orDie),
    line: (text: string) => controller?.enqueue(encoder.encode(`${text}\n`)),
    close: () => controller?.close(),
  };
}

export function fakeBotProcesses(bots: Readonly<Record<string, FakeBot>>) {
  const runs: FakeRun[] = [];
  const stopAllCalls: string[] = [];

  const launch = (spec: BotSpec, bot: FakeBot): BotProcess => {
    const input = inbox();
    const stdout = pipe();
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
