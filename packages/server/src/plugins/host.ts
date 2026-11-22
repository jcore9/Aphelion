import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  parsePluginManifest,
  pluginApiVersion,
  pluginManifestFile,
  type ManifestIssue,
  type PluginManifest,
} from "@aphelion/plugin-sdk";
import {
  Cause,
  Clock,
  Context,
  Data,
  Effect,
  Layer,
  Queue,
  Scope,
} from "effect";
import { z } from "zod";
import type { Logger } from "../log";
import {
  failure,
  notification,
  parseIncoming,
  request,
  rpcErrors,
  success,
  type RpcError,
  type RpcId,
} from "./json-rpc";
import {
  defaultRestartPolicy,
  installed,
  step,
  type LifecycleCommand,
  type LifecycleEvent,
  type LifecycleState,
  type RestartPolicy,
} from "./lifecycle";
import type { Link } from "./link";
import {
  maxPendingInputBytes,
  maxPluginLineBytes,
  type RunnerReply,
  type RunnerRequest,
} from "./runner-protocol";

export interface Permission {
  readonly kind: "event";
  readonly name: string;
}

export class PluginGrants extends Context.Service<
  PluginGrants,
  {
    readonly allows: (
      plugin: string,
      permission: Permission,
    ) => Effect.Effect<boolean>;
  }
>()("aphelion/plugins/PluginGrants") {
  static readonly refuseAll = Layer.succeed(PluginGrants, {
    allows: () => Effect.succeed(false),
  });
}

export class RunnerLink extends Context.Service<
  RunnerLink,
  Link<RunnerReply, RunnerRequest>
>()("aphelion/plugins/RunnerLink") {}

export class PluginRefused extends Data.TaggedError("PluginRefused")<{
  readonly folder: string;
  readonly issues: readonly ManifestIssue[];
}> {}

export class MessageNotSent extends Data.TaggedError("MessageNotSent")<{
  readonly reason: "not serializable" | "too long";
}> {}

export interface PluginEvent {
  readonly name: string;
  readonly data: unknown;
}

export type StartOutcome =
  | { readonly kind: "starting"; readonly id: string }
  | { readonly kind: "client only"; readonly id: string };

export class PluginHost extends Context.Service<
  PluginHost,
  {
    readonly start: (
      folder: string,
    ) => Effect.Effect<StartOutcome, PluginRefused>;
    readonly stop: (id: string) => Effect.Effect<void>;
    readonly publish: (
      event: PluginEvent,
    ) => Effect.Effect<void, MessageNotSent>;
    readonly status: (id: string) => Effect.Effect<LifecycleState | undefined>;
  }
>()("aphelion/plugins/PluginHost") {}

export interface HostOptions {
  readonly logger: Logger;
  readonly policy?: RestartPolicy;
}

type ServerManifest = Extract<PluginManifest, { server: object }>;

type SlotInput =
  | LifecycleEvent
  | { readonly type: "line"; readonly run: number; readonly line: string };

interface Slot {
  readonly id: string;
  readonly mailbox: Queue.Queue<SlotInput>;
  folder: string;
  manifest: ServerManifest;
  state: LifecycleState;
  subscriptions: Set<string>;
  nextRequestId: number;
  initializeId: RpcId | undefined;
  pendingBytes: number;
  floodedRun: number | undefined;
}

const subscribeParams = z.strictObject({ event: z.string().max(128) });

function encode(message: unknown): Effect.Effect<string, MessageNotSent> {
  return Effect.try({
    try: () => JSON.stringify(message),
    catch: () => new MessageNotSent({ reason: "not serializable" }),
  }).pipe(
    Effect.filterOrFail(
      (line) => Buffer.byteLength(line) <= maxPluginLineBytes,
      () => new MessageNotSent({ reason: "too long" }),
    ),
  );
}

const readManifest = (folder: string) =>
  Effect.gen(function* () {
    const refuse = (message: string) =>
      new PluginRefused({ folder, issues: [{ message }] });
    if (!isAbsolute(folder)) {
      return yield* refuse("the plugin folder must be an absolute path");
    }
    const text = yield* Effect.tryPromise({
      try: () => readFile(join(folder, pluginManifestFile), "utf8"),
      catch: () => refuse(`can't read ${pluginManifestFile}`),
    });
    const data = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () => refuse(`${pluginManifestFile} isn't valid JSON`),
    });
    const parsed = parsePluginManifest(data);
    if (!parsed.ok) {
      return yield* new PluginRefused({ folder, issues: parsed.issues });
    }
    return parsed.manifest;
  });

export const pluginHostLayer = (options: HostOptions) =>
  Layer.effect(
    PluginHost,
    Effect.gen(function* () {
      const link = yield* RunnerLink;
      const grants = yield* PluginGrants;
      const scope = yield* Scope.Scope;
      const { logger } = options;
      const policy = options.policy ?? defaultRestartPolicy;
      const slots = new Map<string, Slot>();

      const mayUse = (slot: Slot, permission: Permission) =>
        slot.manifest.permissions.events.includes(permission.name)
          ? grants.allows(slot.id, permission)
          : Effect.succeed(false);

      const sendLine = (slot: Slot, run: number, line: string) =>
        link.send({ type: "input", plugin: slot.id, run, line });

      const send = (slot: Slot, message: unknown) =>
        encode(message).pipe(
          Effect.flatMap((line) => sendLine(slot, slot.state.run, line)),
          Effect.orDie,
        );

      const methods = new Map<
        string,
        (slot: Slot, params: unknown) => Effect.Effect<unknown, RpcError>
      >([
        [
          "events.subscribe",
          (slot, params) =>
            Effect.gen(function* () {
              const parsed = subscribeParams.safeParse(params);
              if (!parsed.success)
                return yield* Effect.fail(rpcErrors.invalidParams);
              const { event } = parsed.data;
              if (!(yield* mayUse(slot, { kind: "event", name: event }))) {
                return yield* Effect.fail(rpcErrors.notGranted);
              }
              slot.subscriptions.add(event);
              return {};
            }),
        ],
      ]);

      const answer = (slot: Slot, method: string, params: unknown) => {
        if (method.startsWith("secrets.")) {
          return Effect.fail(rpcErrors.noSecretOperations);
        }
        const handler = methods.get(method);
        return handler
          ? handler(slot, params)
          : Effect.fail(rpcErrors.methodNotFound);
      };

      const run = (slot: Slot, command: LifecycleCommand) =>
        Effect.gen(function* () {
          switch (command.type) {
            case "spawn":
              slot.subscriptions = new Set();
              slot.initializeId = undefined;
              return yield* link.send({
                type: "start",
                plugin: slot.id,
                run: command.run,
                folder: slot.folder,
                entry: slot.manifest.server.entry,
              });
            case "initialize": {
              const id = slot.nextRequestId++;
              slot.initializeId = id;
              return yield* send(
                slot,
                request(id, "initialize", {
                  api: pluginApiVersion,
                  plugin: slot.id,
                }),
              );
            }
            case "shutdown":
              return yield* send(slot, notification("shutdown"));
            case "kill":
              return yield* link.send({
                type: "stop",
                plugin: slot.id,
                run: slot.state.run,
              });
            case "arm":
              yield* Effect.sleep(command.ms).pipe(
                Effect.andThen(
                  Queue.offer(slot.mailbox, {
                    type: "timer",
                    run: command.run,
                    deadline: command.deadline,
                  }),
                ),
                Effect.forkIn(scope),
              );
          }
        });

      const apply = (slot: Slot, event: LifecycleEvent) =>
        Effect.gen(function* () {
          const before = slot.state;
          const next = step(before, event, policy);
          slot.state = next.state;
          if (next.state.state !== before.state) {
            logger.info("plugin state changed", {
              plugin: slot.id,
              from: before.state,
              to: next.state.state,
              run: next.state.run,
            });
          }
          yield* Effect.forEach(
            next.commands,
            (command) => run(slot, command),
            {
              discard: true,
            },
          );
        });

      const onLine = (slot: Slot, line: string) =>
        Effect.gen(function* () {
          const message = parseIncoming(line);
          const { run } = slot.state;
          switch (message.kind) {
            case "invalid":
              logger.warn("plugin sent a malformed JSON-RPC message", {
                plugin: slot.id,
                code: message.error.code,
              });
              return yield* send(slot, failure(null, message.error));
            case "request": {
              const outcome = yield* Effect.result(
                answer(slot, message.method, message.params),
              );
              return yield* send(
                slot,
                outcome._tag === "Success"
                  ? success(message.id, outcome.success)
                  : failure(message.id, outcome.failure),
              );
            }
            case "result":
            case "error":
              if (message.id === slot.initializeId) {
                slot.initializeId = undefined;
                const at = yield* Clock.currentTimeMillis;
                yield* apply(
                  slot,
                  message.kind === "result"
                    ? { type: "ready", run, at }
                    : { type: "broke-protocol", run },
                );
              }
              return;
            case "notification":
              return;
          }
        });

      const handle = (slot: Slot, input: SlotInput) => {
        if (input.type !== "line") return apply(slot, input);
        slot.pendingBytes -= input.line.length;
        const { state } = slot.state;
        const current = input.run === slot.state.run;
        return current && (state === "starting" || state === "running")
          ? onLine(slot, input.line)
          : Effect.void;
      };

      const toSlotInput = (reply: RunnerReply) =>
        Effect.gen(function* () {
          switch (reply.type) {
            case "started":
              return { type: "spawned", run: reply.run } as const;
            case "start-failed":
              logger.warn("plugin runner couldn't start the plugin", {
                plugin: reply.plugin,
                reason: reply.reason,
              });
              return { type: "spawn-failed", run: reply.run } as const;
            case "output":
              return {
                type: "line",
                run: reply.run,
                line: reply.line,
              } as const;
            case "log":
              logger.info("plugin wrote to stderr", {
                plugin: reply.plugin,
                line: reply.line,
              });
              return undefined;
            case "exited":
              logger.info("plugin process exited", {
                plugin: reply.plugin,
                code: reply.code,
                signal: reply.signal,
              });
              return {
                type: "exited",
                run: reply.run,
                at: yield* Clock.currentTimeMillis,
              } as const;
            case "stopped":
              return { type: "killed", run: reply.run } as const;
          }
        });

      const deliver = (slot: Slot, input: SlotInput) => {
        if (input.type !== "line") return Queue.offer(slot.mailbox, input);
        if (slot.pendingBytes + input.line.length <= maxPendingInputBytes) {
          slot.pendingBytes += input.line.length;
          return Queue.offer(slot.mailbox, input);
        }
        if (slot.floodedRun === input.run) return Effect.void;
        slot.floodedRun = input.run;
        logger.warn("plugin sent messages faster than the host handles them", {
          plugin: slot.id,
        });
        return Queue.offer(slot.mailbox, {
          type: "broke-protocol",
          run: input.run,
        });
      };

      yield* Queue.take(link.incoming).pipe(
        Effect.flatMap((reply) =>
          Effect.gen(function* () {
            const slot = slots.get(reply.plugin);
            const input = yield* toSlotInput(reply);
            if (slot && input) yield* deliver(slot, input);
          }),
        ),
        Effect.forever,
        Effect.catchIf(Cause.isDone, () =>
          Effect.sync(() => {
            logger.error("the plugin runner's pipe closed");
          }),
        ),
        Effect.forkIn(scope),
      );

      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          slots.values(),
          (slot) =>
            link.send({ type: "stop", plugin: slot.id, run: slot.state.run }),
          { discard: true },
        ),
      );

      const start = (folder: string) =>
        Effect.gen(function* () {
          const manifest = yield* readManifest(folder);
          if (manifest.server === undefined) {
            return { kind: "client only", id: manifest.id } as const;
          }
          let slot = slots.get(manifest.id);
          if (!slot) {
            const created: Slot = {
              id: manifest.id,
              mailbox: yield* Queue.unbounded<SlotInput>(),
              folder,
              manifest,
              state: installed,
              subscriptions: new Set(),
              nextRequestId: 1,
              initializeId: undefined,
              pendingBytes: 0,
              floodedRun: undefined,
            };
            slots.set(created.id, created);
            yield* Queue.take(created.mailbox).pipe(
              Effect.flatMap((input) => handle(created, input)),
              Effect.forever,
              Effect.forkIn(scope),
            );
            slot = created;
          } else if (
            slot.state.state === "installed" ||
            slot.state.state === "stopped"
          ) {
            slot.folder = folder;
            slot.manifest = manifest;
          }
          yield* Queue.offer(slot.mailbox, { type: "start" });
          return { kind: "starting", id: manifest.id } as const;
        });

      const publish = (event: PluginEvent) =>
        Effect.gen(function* () {
          const line = yield* encode(
            notification("event", { name: event.name, data: event.data }),
          );
          const receives = (slot: Slot, run: number) =>
            slot.state.state === "running" &&
            slot.state.run === run &&
            slot.subscriptions.has(event.name);
          for (const slot of slots.values()) {
            const { run } = slot.state;
            if (
              receives(slot, run) &&
              (yield* mayUse(slot, { kind: "event", name: event.name })) &&
              receives(slot, run)
            ) {
              yield* sendLine(slot, run, line);
            }
          }
        });

      return PluginHost.of({
        start,
        stop: (id) =>
          Effect.suspend(() => {
            const slot = slots.get(id);
            return slot
              ? Queue.offer(slot.mailbox, { type: "stop" }).pipe(Effect.asVoid)
              : Effect.void;
          }),
        publish,
        status: (id) => Effect.sync(() => slots.get(id)?.state),
      });
    }),
  );
