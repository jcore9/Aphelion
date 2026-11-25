import type {
  AdapterContext,
  AdapterEvent,
  AdapterSession,
  BotAdapter,
  PermissionDecision,
  PermissionRequest,
  TurnInput,
} from "./adapter.ts";

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
    context: AdapterContext,
    signal: AbortSignal,
  ): AsyncGenerator<AdapterEvent> {
    for (const step of steps) {
      if ("emit" in step) yield step.emit;
      else if ("emitRaw" in step) yield step.emitRaw as AdapterEvent;
      else if ("ask" in step) answers.push(await context.decide(step.ask));
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
          return run(steps, context, signal);
        },
        close: () => {
          state.closed = true;
        },
      };
    },
  };
}
