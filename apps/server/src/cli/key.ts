import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { z } from "zod";
import { appendAudit, type Outcome } from "../audit";
import {
  apiKeyRef,
  apiKeyTools,
  checkApiKey,
  providers,
  type ApiKeyTool,
  type CheckResult,
} from "../secrets/api-key";
import { BrokerError, type BrokerClient } from "../secrets/broker-client";
import { withStore } from "./device";
import { failed } from "./failure";
import {
  checkedArgument,
  checkedFlag,
  operands,
  optionalFlag,
  options as flagNames,
  stateDirFlag,
  type Handler,
} from "./flags";
import { CliIo } from "./io";

type Action = "key.add" | "key.replace" | "key.remove" | "key.test";

interface KeyOptions {
  readonly stateDir: string;
  readonly tool: ApiKeyTool;
}

interface Detail {
  readonly result: string;
  readonly status?: number;
}

const record = (
  options: KeyOptions,
  action: Action,
  outcome: Outcome,
  detail: Detail,
) =>
  withStore(options.stateDir, (db) =>
    Effect.sync(() =>
      appendAudit(db, {
        actor: { kind: "cli" },
        action,
        outcome,
        detail: { tool: options.tool, ...detail },
      }),
    ),
  );

const succeed = (
  options: KeyOptions,
  action: Action,
  detail: Detail,
  line: string,
) =>
  Effect.gen(function* () {
    yield* record(options, action, "succeeded", detail);
    yield* (yield* CliIo).out(line);
  });

const refuse = (
  options: KeyOptions,
  action: Action,
  detail: Detail,
  line: string,
) =>
  Effect.gen(function* () {
    yield* (yield* CliIo).err(line);
    yield* record(options, action, "failed", detail);
    return yield* failed;
  });

const fromBroker = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (error) =>
      error instanceof BrokerError
        ? error
        : new BrokerError("the secrets broker request failed"),
  });

const brokerFailures =
  (options: KeyOptions, action: Action) =>
  <A, E, R>(work: Effect.Effect<A, E, R>) =>
    work.pipe(
      Effect.catch((error): Effect.Effect<never, E | Error, CliIo> =>
        error instanceof BrokerError
          ? refuse(options, action, { result: "broker error" }, error.message)
          : Effect.fail(error),
      ),
    );

const notStored = (tool: ApiKeyTool) =>
  `No API key is stored for ${tool}. Add one with: aphelion key add ${tool}`;

const isStored = (broker: BrokerClient, tool: ApiKeyTool) =>
  fromBroker(async () => {
    const existing = await broker.read(apiKeyRef(tool));
    existing?.wipe();
    return existing !== undefined;
  });

const storeKey = (
  options: KeyOptions,
  broker: BrokerClient,
  action: "key.add" | "key.replace",
) =>
  Effect.gen(function* () {
    const io = yield* CliIo;
    const { tool } = options;
    const stored = yield* isStored(broker, tool);
    if (action === "key.add" && stored) {
      return yield* refuse(
        options,
        action,
        { result: "already stored" },
        `An API key for ${tool} is already stored. To change it, run: aphelion key replace ${tool}`,
      );
    }
    if (action === "key.replace" && !stored) {
      return yield* refuse(
        options,
        action,
        { result: "not stored" },
        notStored(tool),
      );
    }
    const input = yield* io.readApiKey(
      `API key for ${tool} (an ${providers[tool].vendor} API key): `,
    );
    if (!input.ok) {
      return yield* refuse(
        options,
        action,
        { result: "input refused" },
        input.reason,
      );
    }
    yield* fromBroker(() => broker.write(apiKeyRef(tool), input.key)).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          input.key.wipe();
        }),
      ),
    );
    const [result, done] =
      action === "key.add" ? ["stored", "Stored"] : ["replaced", "Replaced"];
    yield* succeed(
      options,
      action,
      { result },
      `${done} the ${tool} API key. Test it with: aphelion key test ${tool}`,
    );
  }).pipe(brokerFailures(options, action));

export const keyAdd = (options: KeyOptions, broker: BrokerClient) =>
  storeKey(options, broker, "key.add");

export const keyReplace = (options: KeyOptions, broker: BrokerClient) =>
  storeKey(options, broker, "key.replace");

export const keyRemove = (options: KeyOptions, broker: BrokerClient) =>
  Effect.gen(function* () {
    const { tool } = options;
    const removed = yield* fromBroker(() => broker.delete(apiKeyRef(tool)));
    if (!removed) {
      return yield* refuse(
        options,
        "key.remove",
        { result: "not stored" },
        `No API key is stored for ${tool}.`,
      );
    }
    yield* succeed(
      options,
      "key.remove",
      { result: "removed" },
      `Removed the ${tool} API key.`,
    );
  }).pipe(brokerFailures(options, "key.remove"));

const testOutcome = (tool: ApiKeyTool, result: CheckResult) => {
  switch (result.kind) {
    case "accepted":
      return {
        detail: { result: "accepted" },
        line: `The provider accepted the ${tool} API key.`,
      };
    case "refused":
      return {
        detail: { result: "refused" },
        line: `The provider refused the ${tool} API key. To change it, run: aphelion key replace ${tool}`,
      };
    case "status":
      return {
        detail: { result: "answered", status: result.status },
        line: `The provider answered HTTP ${String(result.status)}, so the ${tool} API key wasn't checked.`,
      };
    case "unreachable":
      return {
        detail: { result: "unreachable" },
        line: "Couldn't reach the provider, or it didn't answer within 10 seconds.",
      };
  }
};

export const keyTest = (
  options: KeyOptions & { readonly testUrl?: string | undefined },
  broker: BrokerClient,
  timeoutMs?: number,
) =>
  Effect.gen(function* () {
    const { tool } = options;
    const key = yield* fromBroker(() => broker.read(apiKeyRef(tool)));
    if (key === undefined) {
      return yield* refuse(
        options,
        "key.test",
        { result: "not stored" },
        notStored(tool),
      );
    }
    const result = yield* Effect.promise(() =>
      checkApiKey(tool, key, {
        ...(options.testUrl === undefined ? {} : { baseUrl: options.testUrl }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          key.wipe();
        }),
      ),
    );
    const { detail, line } = testOutcome(tool, result);
    if (result.kind === "accepted") {
      yield* succeed(options, "key.test", detail, line);
    } else {
      yield* refuse(options, "key.test", detail, line);
    }
  }).pipe(brokerFailures(options, "key.test"));

const apiKeyTool = z
  .string()
  .refine((name) => name !== "opencode", {
    error:
      "can't be opencode, which has no single API key. Sign it in with: sudo aphelion sign-in opencode",
  })
  .pipe(z.enum(apiKeyTools, { error: "must be claude, codex or grok" }));

const toolArgument = (
  command: "key add" | "key replace" | "key test" | "key remove",
) => checkedArgument(operands[command], "tool name", apiKeyTool);

const loopbackUrl = z
  .string()
  .regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/, {
    error: "must be http://127.0.0.1:PORT",
  });

const testUrlFlag = optionalFlag(
  checkedFlag(flagNames.testUrl, loopbackUrl).pipe(
    Flag.withDescription(
      "For Aphelion's own tests: send the check to a fake provider at http://127.0.0.1:PORT",
    ),
  ),
);

export const keyAddCommand = (handler: Handler<KeyOptions>) =>
  Command.make(
    "add",
    { stateDir: stateDirFlag, tool: toolArgument("key add") },
    handler,
  ).pipe(
    Command.withDescription(
      "Read an API key for an AI tool from standard input, with the echo off on a terminal, and store it encrypted. Refuses when one is stored.",
    ),
  );

export const keyReplaceCommand = (handler: Handler<KeyOptions>) =>
  Command.make(
    "replace",
    { stateDir: stateDirFlag, tool: toolArgument("key replace") },
    handler,
  ).pipe(
    Command.withDescription(
      "Read a new API key for an AI tool the same way as key add, and store it in place of the old one. Refuses when none is stored.",
    ),
  );

export const keyTestCommand = (
  handler: Handler<KeyOptions & { readonly testUrl: string | undefined }>,
) =>
  Command.make(
    "test",
    {
      stateDir: stateDirFlag,
      tool: toolArgument("key test"),
      testUrl: testUrlFlag,
    },
    handler,
  ).pipe(
    Command.withDescription(
      "Ask the tool's provider to list its models with the stored key, and say whether it accepted the key. Prints no key and no answer body.",
    ),
  );

export const keyRemoveCommand = (handler: Handler<KeyOptions>) =>
  Command.make(
    "remove",
    { stateDir: stateDirFlag, tool: toolArgument("key remove") },
    handler,
  ).pipe(Command.withDescription("Delete the stored API key for an AI tool."));
