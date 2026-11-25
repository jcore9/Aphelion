import {
  parsePluginManifest,
  pluginApiVersion,
  type PluginManifest,
} from "./manifest.ts";
import type {
  MaybePromise,
  NetworkReply,
  PluginIO,
  ServerPlugin,
} from "./plugin.ts";
import { serve } from "./runtime.ts";
import type { SecretReference } from "./secret-backend.ts";
import {
  failure,
  methods,
  networkGetParams,
  notification,
  pluginLineFits,
  request,
  requestUrl,
  rpcErrors,
  rpcMessageSchema,
  secretsUseParams,
  subscribeParams,
  success,
  type RpcError,
} from "./wire.ts";

/** A permission that the owner granted, for `TestHost.setGrants`. */
export interface Grant {
  /** The manifest list in `permissions` that the permission is in. */
  readonly kind: "events" | "network" | "secrets";
  /** The event name, hostname or secret reference. */
  readonly name: string;
}

/** A secret operation that the test host runs for `secrets.use`. */
export interface FakeSecretOperation {
  /** The secret reference that the plugin must name, and that the plugin needs a grant for. */
  readonly reference: SecretReference;
  /** The hostname that the operation sends to. The plugin needs a network grant for it. */
  readonly host: string;
  /** Runs the operation with the plugin's id. The plugin never sees what it returns or throws, and the call fails after 5 seconds. */
  run(pluginId: string): MaybePromise<unknown>;
}

/** The test host's answer to a request, which is a result or an error. */
export type CallOutcome =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } };

/** One request that the plugin sent to the test host. */
export interface HostCall {
  /** The JSON-RPC method, such as `network.get`. */
  readonly method: string;
  /** The params that the plugin sent. */
  readonly params: unknown;
  /** The test host's answer. */
  readonly outcome: CallOutcome;
}

/**
 * A fake host for a plugin's tests. It checks grants, request shapes and secret operations the way the real host does. Network replies are fixtures from `respondToGet`, not real requests. It does no DNS lookup, public-address check or TLS.
 * Unlike the real host, it can run secret operations that a test registers with `registerSecretOperation`.
 */
export interface TestHost {
  /** Sets what the owner granted, replacing earlier grants. A grant counts only when the manifest also lists the permission. */
  setGrants(grants: readonly Grant[]): void;
  /** Sets the fixture reply to `network.get` for one URL. Nothing is fetched. A URL with no reply, a reply that takes more than 5 seconds, and a body larger than 64 KiB fail with `Operation failed`. */
  respondToGet(url: string, respond: () => MaybePromise<NetworkReply>): void;
  /** Adds a named operation for `secrets.use`. While none is registered, `secrets.use` with a granted reference fails with error `-32002`. */
  registerSecretOperation(name: string, operation: FakeSecretOperation): void;
  /** Starts the plugin and resolves when its `start` has finished, or rejects when `start` fails. A test host starts one plugin only. */
  start(plugin: ServerPlugin): Promise<void>;
  /**
   * Sends an event to the plugin and resolves when its handler has finished.
   * It rejects when the encoded event line is longer than 1 MiB, as the real host does, and sends nothing.
   * It sends nothing and resolves at once when the plugin isn't running, hasn't subscribed, or isn't granted the event, and from the moment `stop` is called.
   */
  publish(name: string, data: unknown): Promise<void>;
  /**
   * Sends `shutdown` and resolves when the plugin has stopped. The SDK first waits up to 3 seconds for handlers that are still running, then runs the plugin's cleanup.
   * A second call resolves when the first one does.
   */
  stop(): Promise<void>;
  /** The messages that the plugin and the SDK logged, in order. */
  readonly logs: readonly string[];
  /** The requests that the plugin sent, with the answers, in the order the test host answered them. */
  readonly calls: readonly HostCall[];
}

type ServerManifest = Extract<PluginManifest, { server: object }>;

const operationTimeoutMs = 5000;
const maxResponseBytes = 64 * 1024;
const initializeId = 1;

function serverManifest(data: unknown): ServerManifest {
  const parsed = parsePluginManifest(data);
  if (!parsed.ok) {
    const issues = parsed.issues.map(
      ({ field, message }) => `${field ?? "manifest"} ${message}`,
    );
    throw new Error(`the manifest is invalid: ${issues.join("; ")}`);
  }
  if (!parsed.manifest.server) {
    throw new Error("the manifest has no server part");
  }
  return parsed.manifest;
}

function lineQueue() {
  const queued: string[] = [];
  let waiting: ((next: IteratorResult<string, undefined>) => void) | undefined;
  let ended = false;
  const end = () => {
    ended = true;
    waiting?.({ done: true, value: undefined });
    waiting = undefined;
  };
  const iterator: AsyncIterator<string, undefined> = {
    next: () => {
      const line = queued.shift();
      if (line !== undefined)
        return Promise.resolve({ done: false, value: line });
      if (ended) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    return: () => {
      end();
      return Promise.resolve({ done: true, value: undefined });
    },
  };
  const pushLine = (line: string) => {
    if (ended) return;
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve({ done: false, value: line });
    } else {
      queued.push(line);
    }
  };
  return {
    push: (message: unknown) => {
      pushLine(JSON.stringify(message));
    },
    pushLine,
    end,
    input: { [Symbol.asyncIterator]: () => iterator },
  };
}

function adoptLater() {
  let adopt: (settled: Promise<void>) => void = () => undefined;
  const promise: Promise<void> = new Promise((resolve, reject) => {
    adopt = (settled) => {
      settled.then(resolve, reject);
    };
  });
  return { promise, adopt };
}

const refuse = ({ code, message }: RpcError): CallOutcome => ({
  error: { code, message },
});

async function withinTimeout<T>(work: () => MaybePromise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("timed out"));
    }, operationTimeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(work), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Makes a test host for a plugin's manifest, with nothing granted. It throws when the manifest is invalid or has no server part. */
export function createTestHost(manifestData: unknown): TestHost {
  const manifest = serverManifest(manifestData);
  const toPlugin = lineQueue();
  const logs: string[] = [];
  const calls: HostCall[] = [];
  const responses = new Map<string, () => MaybePromise<NetworkReply>>();
  const secretOperations = new Map<string, FakeSecretOperation>();
  const subscriptions = new Set<string>();
  const deliveries: ((settled: Promise<void>) => void)[] = [];
  let grants: readonly Grant[] = [];
  let running = false;
  let run: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;

  const allows = (kind: Grant["kind"], name: string) => {
    const declared: readonly string[] = manifest.permissions[kind];
    return (
      declared.includes(name) &&
      grants.some((grant) => grant.kind === kind && grant.name === name)
    );
  };

  const subscribe = (params: unknown): CallOutcome => {
    const parsed = subscribeParams.safeParse(params);
    if (!parsed.success) return refuse(rpcErrors.invalidParams);
    if (!allows("events", parsed.data.event))
      return refuse(rpcErrors.notGranted);
    subscriptions.add(parsed.data.event);
    return { result: {} };
  };

  const networkGet = async (params: unknown): Promise<CallOutcome> => {
    const parsed = networkGetParams.safeParse(params);
    const url = parsed.success ? requestUrl(parsed.data.url) : undefined;
    if (!url) return refuse(rpcErrors.invalidParams);
    if (!allows("network", url.hostname)) return refuse(rpcErrors.notGranted);
    const respond = responses.get(url.href);
    if (!respond) return refuse(rpcErrors.operationFailed);
    try {
      const { status, body } = await withinTimeout(respond);
      if (new TextEncoder().encode(body).byteLength > maxResponseBytes)
        return refuse(rpcErrors.operationFailed);
      return { result: { status, body } };
    } catch {
      return refuse(rpcErrors.operationFailed);
    }
  };

  const secretsUse = async (params: unknown): Promise<CallOutcome> => {
    const parsed = secretsUseParams.safeParse(params);
    if (!parsed.success) return refuse(rpcErrors.invalidParams);
    const { operation, reference } = parsed.data;
    if (!allows("secrets", reference)) return refuse(rpcErrors.notGranted);
    if (secretOperations.size === 0)
      return refuse(rpcErrors.noSecretOperations);
    const action = secretOperations.get(operation);
    if (action?.reference !== reference) return refuse(rpcErrors.notGranted);
    if (!allows("network", action.host)) return refuse(rpcErrors.notGranted);
    try {
      await withinTimeout(() => action.run(manifest.id));
      return { result: {} };
    } catch {
      return refuse(rpcErrors.operationFailed);
    }
  };

  const answer = (method: string, params: unknown) => {
    switch (method) {
      case methods.subscribe:
        return subscribe(params);
      case methods.networkGet:
        return networkGet(params);
      case methods.secretsUse:
        return secretsUse(params);
      default:
        return refuse(rpcErrors.methodNotFound);
    }
  };

  const receive = async (line: string) => {
    if (stopping) return;
    const parsed = rpcMessageSchema.safeParse(JSON.parse(line));
    if (!parsed.success) return;
    const message = parsed.data;
    if ("result" in message && message.id === initializeId) running = true;
    if (!("method" in message && "id" in message)) return;
    const outcome = await answer(message.method, message.params);
    calls.push({ method: message.method, params: message.params, outcome });
    toPlugin.push(
      "result" in outcome
        ? success(message.id, outcome.result)
        : failure(message.id, outcome.error),
    );
  };

  const io: PluginIO = {
    input: toPlugin.input,
    write: (line) => {
      void receive(line);
      return Promise.resolve();
    },
    log: (message) => {
      logs.push(message);
    },
  };

  return {
    setGrants(next) {
      grants = [...next];
    },
    respondToGet(url, respond) {
      responses.set(new URL(url).href, respond);
    },
    registerSecretOperation(name, operation) {
      secretOperations.set(name, operation);
    },
    async start(plugin) {
      if (run) throw new Error("the test host has already started a plugin");
      const started = adoptLater();
      run = serve(plugin, io, {
        started: started.adopt,
        delivered: (settled) => deliveries.shift()?.(settled),
      }).finally(() => {
        running = false;
        for (const deliver of deliveries.splice(0)) deliver(Promise.resolve());
      });
      run.catch(() => undefined);
      toPlugin.push(
        request(initializeId, methods.initialize, {
          api: pluginApiVersion,
          plugin: manifest.id,
        }),
      );
      await Promise.race([started.promise, run]);
    },
    async publish(name, data) {
      const line = JSON.stringify(notification(methods.event, { name, data }));
      if (!pluginLineFits(line)) {
        throw new Error(
          "the event is longer than 1 MiB once encoded, so the host refuses it",
        );
      }
      if (!running || !subscriptions.has(name) || !allows("events", name))
        return;
      const delivered = adoptLater();
      deliveries.push(delivered.adopt);
      toPlugin.pushLine(line);
      await delivered.promise;
    },
    stop() {
      if (!run) return Promise.resolve();
      const stopped = run.catch(() => undefined);
      stopping ??= (async () => {
        running = false;
        toPlugin.push(notification(methods.shutdown));
        await stopped;
        toPlugin.end();
      })();
      return stopping;
    },
    logs,
    calls,
  };
}
