import {
  adapterApiVersion,
  adapterEnvelope,
  adapterMethods,
  type AdapterContext,
  type AdapterEnvelope,
  type AdapterEvent,
  type AdapterSession,
  type BotAdapter,
  type PermissionDecision,
  type PermissionRequest,
  type TurnInput,
} from "./adapter.ts";
import { runAdapter, type RunAdapterOptions } from "./adapter-runtime.ts";
import { lineQueue } from "./line-queue.ts";
import { request, rpcMessageSchema, type RpcError } from "./wire.ts";

/** One step of a fake turn. The fake adapter runs a turn's steps in order. */
export type FakeStep =
  | {
      /** Yields this event. */
      readonly emit: AdapterEvent;
    }
  | {
      /** Yields this value as it is, even when it isn't a valid event. Use it to test what the runtime does with a broken adapter. */
      readonly emitRaw: unknown;
    }
  | {
      /** Calls `decide` with this request and keeps the answer in `FakeAdapter.answers`. */
      readonly ask: PermissionRequest;
    }
  | {
      /** Waits for this promise before the next step, such as a gate that the test opens later. */
      readonly wait: PromiseLike<unknown>;
    }
  | {
      /** Waits until the turn's signal aborts, as an adapter that honors a cancel does. */
      readonly waitForAbort: true;
    }
  | {
      /** Waits forever and ignores the signal, as an adapter that ignores a cancel does. */
      readonly hang: true;
    }
  | {
      /** Throws an error from the stream. */
      readonly throws: true;
    };

/** A script's turns. The first turn that the runtime starts runs the first list of steps, the second turn the second list, and so on. A turn past the end of the script yields nothing. */
export type FakeScript = readonly (readonly FakeStep[])[];

/** A `BotAdapter` that runs a script, and keeps what the runtime gave it. */
export interface FakeAdapter extends BotAdapter {
  /** The contexts that `open` received. */
  readonly contexts: readonly AdapterContext[];
  /** The turns the runtime started, in order. */
  readonly inputs: readonly TurnInput[];
  /** The signal of each turn, in order. */
  readonly signals: readonly AbortSignal[];
  /** The answers to the `ask` steps, in order. */
  readonly answers: readonly PermissionDecision[];
  /** Whether the runtime has called `close`. */
  readonly closed: boolean;
}

/** Makes an adapter that runs `script`. Its provider is `fake` unless `provider` says otherwise. */
export function fakeAdapter(
  script: FakeScript,
  provider = "fake",
): FakeAdapter {
  const contexts: AdapterContext[] = [];
  const inputs: TurnInput[] = [];
  const signals: AbortSignal[] = [];
  const answers: PermissionDecision[] = [];
  const state = { closed: false };

  const never = new Promise<never>(() => undefined);

  async function* run(
    steps: readonly FakeStep[],
    input: TurnInput,
    signal: AbortSignal,
  ): AsyncGenerator<AdapterEvent> {
    for (const step of steps) {
      if ("emit" in step) yield step.emit;
      else if ("emitRaw" in step) yield step.emitRaw as AdapterEvent;
      else if ("ask" in step) answers.push(await input.decide(step.ask));
      else if ("wait" in step) await step.wait;
      else if ("waitForAbort" in step) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener(
              "abort",
              () => {
                resolve();
              },
              { once: true },
            );
        });
      } else if ("hang" in step) await never;
      else throw new Error("the fake adapter was told to throw");
    }
  }

  return {
    provider,
    contexts,
    inputs,
    signals,
    answers,
    get closed() {
      return state.closed;
    },
    open(context): AdapterSession {
      contexts.push(context);
      return {
        turn: (input, signal) => {
          const steps = script[inputs.length] ?? [];
          inputs.push(input);
          signals.push(signal);
          return run(steps, input, signal);
        },
        close: () => {
          state.closed = true;
        },
      };
    },
  };
}

/** The bot adapter's reply to a request, which is a result or an error. */
export type AdapterReply =
  { readonly result: unknown } | { readonly error: RpcError };

/** A fake bot runner that talks to an adapter's runtime over JSON lines, and keeps what it receives. */
export interface AdapterHarness {
  /** The events that the adapter sent, in order. */
  readonly events: readonly AdapterEnvelope[];
  /** The messages that the runtime logged. */
  readonly logs: readonly string[];
  /** Lines the runtime sent that the harness couldn't read, such as an event that fails its schema. A good test leaves this empty. */
  readonly problems: readonly string[];
  /** Settles when the runtime stops: it resolves after `shutdown` and rejects when the runtime fails. */
  readonly done: Promise<void>;
  /** Sends `initialize` for a bot called `bot-1` in the folder `/work`, with no session to resume unless `resume` says otherwise. */
  initialize(resume?: string | null): Promise<AdapterReply>;
  /** Sends `turn.start`. The reply comes when the runtime accepts the turn, not when the turn ends. */
  startTurn(turn: string, text: string): Promise<AdapterReply>;
  /** Sends `turn.cancel`. */
  cancel(turn: string): Promise<AdapterReply>;
  /** Sends `shutdown` and waits for the reply. */
  shutdown(): Promise<AdapterReply>;
  /** Resolves with the first event that `match` accepts, including one that has arrived already. */
  untilEvent(
    match: (event: AdapterEnvelope) => boolean,
  ): Promise<AdapterEnvelope>;
}

/** Starts the adapter's runtime with a fake bot runner on the other end of its lines. */
export function startAdapter(
  adapter: BotAdapter,
  options?: RunAdapterOptions,
): AdapterHarness {
  const toAdapter = lineQueue();
  const events: AdapterEnvelope[] = [];
  const logs: string[] = [];
  const problems: string[] = [];
  const replies = new Map<number, (reply: AdapterReply) => void>();
  const watchers: (() => void)[] = [];
  let nextId = 1;

  const receive = (line: string) => {
    const parsed = rpcMessageSchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      problems.push("a line that isn't a JSON-RPC message");
      return;
    }
    const message = parsed.data;
    if ("method" in message) {
      const envelope = adapterEnvelope.safeParse(message.params);
      if (message.method !== adapterMethods.event || !envelope.success) {
        problems.push(`a ${message.method} message that isn't a valid event`);
        return;
      }
      events.push(envelope.data);
      for (const wake of watchers.splice(0)) wake();
      return;
    }
    if (typeof message.id !== "number") return;
    const settle = replies.get(message.id);
    replies.delete(message.id);
    settle?.(
      "result" in message
        ? { result: message.result }
        : { error: message.error },
    );
  };

  const done = runAdapter(
    adapter,
    {
      input: toAdapter.input,
      write: (line) => {
        receive(line);
        return Promise.resolve();
      },
      log: (message) => {
        logs.push(message);
      },
    },
    options,
  ).finally(() => {
    toAdapter.end();
  });
  done.catch(() => undefined);

  const call = (method: string, params: unknown) =>
    new Promise<AdapterReply>((resolve) => {
      const id = nextId++;
      replies.set(id, resolve);
      toAdapter.push(request(id, method, params));
    });

  return {
    events,
    logs,
    problems,
    done,
    initialize: (resume = null) =>
      call(adapterMethods.initialize, {
        api: adapterApiVersion,
        bot: { id: "bot-1" },
        folder: "/work",
        resume,
      }),
    startTurn: (turn, text) => call(adapterMethods.turnStart, { turn, text }),
    cancel: (turn) => call(adapterMethods.turnCancel, { turn }),
    shutdown: () => call(adapterMethods.shutdown, undefined),
    untilEvent: async (match) => {
      for (;;) {
        const found = events.find(match);
        if (found) return found;
        await new Promise<void>((resolve) => watchers.push(resolve));
      }
    },
  };
}

/** What `runTurn` returns. */
export interface TurnRun {
  /** The reply to `turn.start`. An error reply means the runtime refused the turn, and then nothing else ran. */
  readonly reply: AdapterReply;
  /** Every event that the adapter sent, in order. */
  readonly events: readonly AdapterEnvelope[];
  /** The messages that the runtime logged. */
  readonly logs: readonly string[];
  /** Lines the harness couldn't read. */
  readonly problems: readonly string[];
}

/**
 * Runs one turn the way the bot runner does: `initialize`, `turn.start`, waiting for `turn.end`, then `shutdown`.
 * `turn` is `t1` unless the options say otherwise, and `text` is `hello`.
 */
export async function runTurn(
  adapter: BotAdapter,
  options: RunAdapterOptions & { turn?: string; text?: string } = {},
): Promise<TurnRun> {
  const { turn = "t1", text = "hello", ...runtime } = options;
  const harness = startAdapter(adapter, runtime);
  await harness.initialize();
  const reply = await harness.startTurn(turn, text);
  if ("result" in reply) {
    await harness.untilEvent(
      ({ turn: id, event }) => id === turn && event.type === "turn.end",
    );
  }
  await harness.shutdown();
  await harness.done;
  return {
    reply,
    events: harness.events,
    logs: harness.logs,
    problems: harness.problems,
  };
}
