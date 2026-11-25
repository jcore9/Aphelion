import {
  networkGetParams,
  pluginApiVersion,
  pluginLineFits,
  requestUrl,
  secretsUseParams,
  subscribeParams,
  type PluginManifest,
} from "@aphelion/plugin-sdk";
import {
  Cause,
  Clock,
  Context,
  Data,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Queue,
  Scope,
} from "effect";
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
import type { Approval } from "./approvals";
import type { Link } from "./link";
import { PluginRefused, readManifest } from "./manifest-file";
import {
  declaresPermission,
  permissionList,
  PluginGrants,
  type Permission,
} from "./grants";
import { networkRequest, type NetworkRequest } from "./network";
import { filesDigest } from "./tree-digest";
import {
  maxPendingInputBytes,
  type RunnerReply,
  type RunnerRequest,
} from "./runner-protocol";

export class RunnerLink extends Context.Service<
  RunnerLink,
  Link<RunnerReply, RunnerRequest>
>()("aphelion/plugins/RunnerLink") {}

export class RunnerClosed extends Data.TaggedError("RunnerClosed") {}

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
      approval?: Approval,
    ) => Effect.Effect<StartOutcome, PluginRefused>;
    readonly stop: (id: string) => Effect.Effect<void>;
    readonly waitFor: (
      id: string,
      until: (state: LifecycleState) => boolean,
    ) => Effect.Effect<LifecycleState | undefined, RunnerClosed>;
    readonly publish: (
      event: PluginEvent,
    ) => Effect.Effect<void, MessageNotSent>;
    readonly status: (id: string) => Effect.Effect<LifecycleState | undefined>;
  }
>()("aphelion/plugins/PluginHost") {}

export interface HostOptions {
  readonly logger: Logger;
  readonly policy?: RestartPolicy;
  readonly network?: NetworkRequest;
  readonly secretOperations?: ReadonlyMap<string, SecretOperation>;
  readonly stopDeadlineMs?: number;
}

export const defaultStopDeadlineMs = 10_000;

interface SecretOperation {
  readonly reference: string;
  readonly host: string;
  readonly run: (plugin: string) => Effect.Effect<void, unknown>;
}

type ServerManifest = Extract<PluginManifest, { server: object }>;

interface Waiter {
  readonly until: (state: LifecycleState) => boolean;
  readonly done: Deferred.Deferred<LifecycleState, RunnerClosed>;
  cancelled: boolean;
}

type SlotInput =
  | LifecycleEvent
  | { readonly type: "line"; readonly run: number; readonly line: string }
  | ({ readonly type: "wait" } & Waiter);

interface Slot {
  readonly id: string;
  readonly mailbox: Queue.Queue<SlotInput>;
  folder: string;
  approval: Approval;
  manifest: ServerManifest;
  state: LifecycleState;
  subscriptions: Set<string>;
  nextRequestId: number;
  initializeId: RpcId | undefined;
  pending: { bytes: number; messages: number };
  floodedRun: number | undefined;
  blockedRun: number | undefined;
  operation: { fiber?: Fiber.Fiber<void> } | undefined;
  readonly waiters: Set<Waiter>;
}

const isStopped = (state: LifecycleState) =>
  state.state === "stopped" || state.state === "installed";

const maxPendingInputMessages = 4096;
const pendingCost = (line: string) => 2 * line.length + 256;

function encode(message: unknown): Effect.Effect<string, MessageNotSent> {
  return Effect.try({
    try: () => JSON.stringify(message),
    catch: () => new MessageNotSent({ reason: "not serializable" }),
  }).pipe(
    Effect.filterOrFail(
      pluginLineFits,
      () => new MessageNotSent({ reason: "too long" }),
    ),
  );
}

export const pluginHostLayer = (options: HostOptions) =>
  Layer.effect(
    PluginHost,
    Effect.gen(function* () {
      const link = yield* RunnerLink;
      const grants = yield* PluginGrants;
      const work = yield* Scope.fork(yield* Scope.Scope);
      const { logger } = options;
      const policy = options.policy ?? defaultRestartPolicy;
      const stopDeadlineMs = options.stopDeadlineMs ?? defaultStopDeadlineMs;
      const slots = new Map<string, Slot>();

      const mayUse = (slot: Slot, permission: Permission) =>
        declaresPermission(slot.manifest, permission)
          ? grants.allows(slot.approval, permission)
          : Effect.succeed(false);

      const refusal = (
        folder: string,
        manifest: PluginManifest,
        approval: Approval,
      ) =>
        Effect.gen(function* () {
          const again = `Run aphelion plugin install ${folder} to approve it.`;
          if (
            manifest.id !== approval.id ||
            manifest.version !== approval.version
          ) {
            return `the plugin is ${manifest.id} ${manifest.version}, but ${approval.id} ${approval.version} was approved. ${again}`;
          }
          if (folder !== approval.folder) {
            return `the plugin folder doesn't match its approval. ${again}`;
          }
          if (approval.filesDigest !== undefined) {
            const digest = yield* Effect.result(filesDigest(folder));
            if (digest._tag === "Failure") {
              return `the plugin's files can't be checked: ${digest.failure.reason}.`;
            }
            if (digest.success !== approval.filesDigest) {
              return `the plugin's files changed since they were approved. ${again}`;
            }
          }
          if (!(yield* grants.hasApproval(approval))) {
            return `the plugin's approval is no longer present. ${again}`;
          }
          const ungranted = yield* Effect.filter(
            permissionList(manifest),
            (permission) =>
              grants
                .allows(approval, permission)
                .pipe(Effect.map((allowed) => !allowed)),
          );
          if (ungranted.length > 0) {
            const names = ungranted
              .map(({ kind, name }) => `${kind} ${JSON.stringify(name)}`)
              .join(", ");
            return `the plugin asks for permissions that weren't approved: ${names}. ${again}`;
          }
          return undefined;
        });

      const sendLine = (slot: Slot, run: number, line: string) =>
        link.send({ type: "input", plugin: slot.id, run, line });

      const send = (slot: Slot, message: unknown, run = slot.state.run) =>
        encode(message).pipe(
          Effect.flatMap((line) => sendLine(slot, run, line)),
          Effect.orDie,
        );

      const requireGrant = (slot: Slot, permission: Permission) =>
        mayUse(slot, permission).pipe(
          Effect.filterOrFail(
            (allowed) => allowed,
            () => rpcErrors.notGranted,
          ),
        );

      const mayOperate = (slot: Slot, run: number) =>
        slot.state.state === "running" &&
        slot.state.run === run &&
        slot.blockedRun !== run;

      const operations = new Map<
        string,
        (
          slot: Slot,
          params: unknown,
          run: number,
        ) => Effect.Effect<unknown, RpcError>
      >([
        [
          "network.get",
          (slot, params, run) =>
            Effect.gen(function* () {
              const parsed = networkGetParams.safeParse(params);
              if (!parsed.success)
                return yield* Effect.fail(rpcErrors.invalidParams);
              const url = requestUrl(parsed.data.url);
              if (url === undefined)
                return yield* Effect.fail(rpcErrors.invalidParams);
              yield* requireGrant(slot, {
                kind: "network",
                name: url.hostname,
              });
              if (!mayOperate(slot, run))
                return yield* Effect.fail(rpcErrors.notGranted);
              return yield* (options.network ?? networkRequest)(url);
            }),
        ],
        [
          "secrets.use",
          (slot, params, run) =>
            Effect.gen(function* () {
              const parsed = secretsUseParams.safeParse(params);
              if (!parsed.success)
                return yield* Effect.fail(rpcErrors.invalidParams);
              const { reference, operation } = parsed.data;
              yield* requireGrant(slot, { kind: "secrets", name: reference });
              if (!options.secretOperations)
                return yield* Effect.fail(rpcErrors.noSecretOperations);
              const action = options.secretOperations.get(operation);
              if (action?.reference !== reference)
                return yield* Effect.fail(rpcErrors.notGranted);
              yield* requireGrant(slot, { kind: "network", name: action.host });
              if (!mayOperate(slot, run))
                return yield* Effect.fail(rpcErrors.notGranted);
              yield* action.run(slot.id).pipe(
                Effect.asVoid,
                Effect.timeout("5 seconds"),
                Effect.catchCause(() => Effect.fail(rpcErrors.operationFailed)),
              );
              return {};
            }),
        ],
      ]);

      const subscribe = (slot: Slot, params: unknown) =>
        Effect.gen(function* () {
          const parsed = subscribeParams.safeParse(params);
          if (!parsed.success)
            return yield* Effect.fail(rpcErrors.invalidParams);
          const { event } = parsed.data;
          yield* requireGrant(slot, { kind: "events", name: event });
          slot.subscriptions.add(event);
          return {};
        });

      const reply = (
        slot: Slot,
        id: RpcId,
        answer: Effect.Effect<unknown, RpcError>,
      ) =>
        Effect.gen(function* () {
          const outcome = yield* Effect.result(answer);
          yield* send(
            slot,
            outcome._tag === "Success"
              ? success(id, outcome.success)
              : failure(id, outcome.failure),
          );
        });

      const startOperation = (
        slot: Slot,
        id: RpcId,
        run: number,
        answer: Effect.Effect<unknown, RpcError>,
      ) =>
        Effect.gen(function* () {
          if (!mayOperate(slot, run))
            return yield* send(slot, failure(id, rpcErrors.notGranted));
          if (slot.operation)
            return yield* send(slot, failure(id, rpcErrors.busy));
          const operation: NonNullable<Slot["operation"]> = {};
          slot.operation = operation;
          const release = Effect.sync(() => {
            if (slot.operation === operation) slot.operation = undefined;
          });
          operation.fiber = yield* Effect.gen(function* () {
            if (!mayOperate(slot, run)) return;
            const outcome = yield* Effect.result(answer).pipe(
              Effect.ensuring(release),
            );
            if (!mayOperate(slot, run)) return;
            yield* send(
              slot,
              outcome._tag === "Success"
                ? success(id, outcome.success)
                : failure(id, outcome.failure),
              run,
            );
          }).pipe(Effect.ensuring(release), Effect.forkIn(work));
        });

      const run = (slot: Slot, command: LifecycleCommand) =>
        Effect.gen(function* () {
          switch (command.type) {
            case "spawn": {
              const loaded = yield* Effect.result(readManifest(slot.folder));
              if (
                loaded._tag === "Failure" ||
                loaded.success.folder !== slot.folder ||
                loaded.success.manifest.id !== slot.id ||
                !loaded.success.manifest.server
              ) {
                yield* Queue.offer(slot.mailbox, {
                  type: "spawn-failed",
                  run: command.run,
                });
                return;
              }
              const { manifest } = loaded.success;
              const refused = yield* refusal(
                slot.folder,
                manifest,
                slot.approval,
              );
              if (refused) {
                logger.error(
                  "a plugin changed since it was approved, so it won't start",
                  { plugin: slot.id, reason: refused },
                );
                yield* Queue.offer(slot.mailbox, {
                  type: "spawn-failed",
                  run: command.run,
                });
                return;
              }
              slot.manifest = manifest;
              slot.subscriptions = new Set();
              slot.initializeId = undefined;
              return yield* link.send({
                type: "start",
                plugin: slot.id,
                run: command.run,
                folder: slot.folder,
                entry: manifest.server.entry,
              });
            }
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
                Effect.forkIn(work),
              );
          }
        });

      let runnerClosed = false;
      let closing = false;

      const settleWaiters = (slot: Slot) =>
        Effect.forEach(
          [...slot.waiters].filter(
            (waiter) => runnerClosed || waiter.until(slot.state),
          ),
          (waiter) => {
            slot.waiters.delete(waiter);
            return runnerClosed
              ? Deferred.fail(waiter.done, new RunnerClosed())
              : Deferred.succeed(waiter.done, slot.state);
          },
          { discard: true },
        );

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
          yield* settleWaiters(slot);
          if (
            before.state === "running" &&
            next.state.state !== "running" &&
            slot.operation?.fiber
          ) {
            yield* Fiber.interrupt(slot.operation.fiber).pipe(
              Effect.forkIn(work),
            );
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
              const operation = operations.get(message.method);
              if (operation)
                return yield* startOperation(
                  slot,
                  message.id,
                  run,
                  operation(slot, message.params, run),
                );
              return yield* reply(
                slot,
                message.id,
                message.method === "events.subscribe"
                  ? subscribe(slot, message.params)
                  : Effect.fail(rpcErrors.methodNotFound),
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
                    : { type: "broke-protocol", run, at },
                );
              }
              return;
            case "notification":
              return;
          }
        });

      const handle = (slot: Slot, input: SlotInput) => {
        if (
          closing &&
          (input.type === "start" ||
            (input.type === "timer" && input.deadline === "retry"))
        )
          return Effect.void;
        if (input.type === "wait") {
          if (input.cancelled) return Effect.void;
          slot.waiters.add(input);
          return settleWaiters(slot);
        }
        if (input.type !== "line") return apply(slot, input);
        slot.pending.bytes -= pendingCost(input.line);
        slot.pending.messages--;
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
        if (slot.floodedRun === input.run) return Effect.void;
        const cost = pendingCost(input.line);
        if (
          slot.pending.bytes + cost <= maxPendingInputBytes &&
          slot.pending.messages < maxPendingInputMessages
        ) {
          slot.pending.bytes += cost;
          slot.pending.messages++;
          return Queue.offer(slot.mailbox, input);
        }
        slot.floodedRun = input.run;
        logger.warn("plugin sent messages faster than the host handles them", {
          plugin: slot.id,
        });
        return Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;
          const backlog = yield* Queue.clear(slot.mailbox);
          slot.pending = { bytes: 0, messages: 0 };
          yield* Queue.offerAll(slot.mailbox, [
            { type: "broke-protocol", run: input.run, at },
            ...backlog.filter((queued) => queued.type !== "line"),
          ]);
        });
      };

      yield* Queue.take(link.incoming).pipe(
        Effect.flatMap((reply) =>
          Effect.gen(function* () {
            const slot = slots.get(reply.plugin);
            const input = yield* toSlotInput(reply);
            if (slot && input) {
              if (
                (reply.type === "exited" || reply.type === "stopped") &&
                reply.run === slot.state.run
              ) {
                slot.blockedRun = reply.run;
              }
              yield* deliver(slot, input);
            }
          }),
        ),
        Effect.forever,
        Effect.catchIf(Cause.isDone, () =>
          Effect.gen(function* () {
            logger.error("the plugin runner's pipe closed");
            runnerClosed = true;
            yield* Effect.forEach(slots.values(), settleWaiters, {
              discard: true,
            });
          }),
        ),
        Effect.forkIn(work),
      );

      const start = (path: string, approval?: Approval) =>
        Effect.gen(function* () {
          const { manifest, folder } = yield* readManifest(path);
          if (approval === undefined) {
            return yield* new PluginRefused({
              folder: path,
              issues: [
                {
                  message: `the plugin has no approval. Run aphelion plugin install ${folder} to approve it.`,
                },
              ],
            });
          }
          const refused = yield* refusal(folder, manifest, approval);
          if (refused) {
            return yield* new PluginRefused({
              folder: path,
              issues: [{ message: refused }],
            });
          }
          if (manifest.server === undefined) {
            return { kind: "client only", id: manifest.id } as const;
          }
          let slot = slots.get(manifest.id);
          if (!slot) {
            const created: Slot = {
              id: manifest.id,
              mailbox: yield* Queue.unbounded<SlotInput>(),
              folder,
              approval,
              manifest,
              state: installed,
              subscriptions: new Set(),
              nextRequestId: 1,
              initializeId: undefined,
              pending: { bytes: 0, messages: 0 },
              floodedRun: undefined,
              blockedRun: undefined,
              operation: undefined,
              waiters: new Set(),
            };
            slots.set(created.id, created);
            yield* Queue.take(created.mailbox).pipe(
              Effect.flatMap((input) => handle(created, input)),
              Effect.forever,
              Effect.forkIn(work),
            );
            slot = created;
          } else if (
            slot.state.state === "installed" ||
            slot.state.state === "stopped"
          ) {
            slot.folder = folder;
            slot.approval = approval;
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
              (yield* mayUse(slot, { kind: "events", name: event.name })) &&
              receives(slot, run)
            ) {
              yield* sendLine(slot, run, line);
            }
          }
        });

      const waitFor = (id: string, until: Waiter["until"]) =>
        Effect.gen(function* () {
          const slot = slots.get(id);
          if (!slot) return undefined;
          if (runnerClosed) return yield* new RunnerClosed();
          const waiter = {
            type: "wait" as const,
            until,
            done: yield* Deferred.make<LifecycleState, RunnerClosed>(),
            cancelled: false,
          };
          return yield* Queue.offer(slot.mailbox, waiter).pipe(
            Effect.andThen(Deferred.await(waiter.done)),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                waiter.cancelled = true;
                slot.waiters.delete(waiter);
              }),
            ),
          );
        });

      const stopSlot = (slot: Slot) =>
        Effect.suspend(() => {
          slot.blockedRun = slot.state.run;
          return Queue.offer(slot.mailbox, { type: "stop" }).pipe(
            Effect.andThen(waitFor(slot.id, isStopped)),
            Effect.asVoid,
            Effect.catchTag("RunnerClosed", () => Effect.void),
          );
        });

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closing = true;
          const all = [...slots.values()];
          logger.info("the plugin host is stopping every plugin", {
            plugins: all.length,
          });
          const forceMs = stopDeadlineMs / 10;
          yield* Effect.forEach(all, stopSlot, {
            concurrency: "unbounded",
            discard: true,
          }).pipe(Effect.timeoutOption(stopDeadlineMs - forceMs));
          const left = all.filter((slot) => !isStopped(slot.state));
          if (left.length === 0 || runnerClosed) return;
          logger.warn(
            "plugins were still running at the stop deadline, so the host told the runner to kill them",
            { plugins: left.map((slot) => slot.id) },
          );
          yield* Effect.forEach(
            left,
            (slot) =>
              link.send({ type: "stop", plugin: slot.id, run: slot.state.run }),
            { discard: true },
          ).pipe(Effect.timeoutOption(forceMs));
        }),
      );

      return PluginHost.of({
        start,
        stop: (id) =>
          Effect.suspend(() => {
            const slot = slots.get(id);
            return slot ? stopSlot(slot) : Effect.void;
          }),
        waitFor,
        publish,
        status: (id) => Effect.sync(() => slots.get(id)?.state),
      });
    }),
  );
