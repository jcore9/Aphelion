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
  request,
  requestUrl,
  rpcErrors,
  rpcMessageSchema,
  secretsUseParams,
  subscribeParams,
  success,
  type RpcError,
} from "./wire.ts";

export interface Grant {
  readonly kind: "events" | "network" | "secrets";
  readonly name: string;
}

export interface FakeSecretOperation {
  readonly reference: SecretReference;
  readonly host: string;
  run(pluginId: string): MaybePromise<unknown>;
}

export type CallOutcome =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } };

export interface HostCall {
  readonly method: string;
  readonly params: unknown;
  readonly outcome: CallOutcome;
}

export interface TestHost {
  setGrants(grants: readonly Grant[]): void;
  respondToGet(url: string, respond: () => MaybePromise<NetworkReply>): void;
  registerSecretOperation(name: string, operation: FakeSecretOperation): void;
  start(plugin: ServerPlugin): Promise<void>;
  publish(name: string, data: unknown): Promise<void>;
  stop(): Promise<void>;
  readonly logs: readonly string[];
  readonly calls: readonly HostCall[];
}

type ServerManifest = Extract<PluginManifest, { server: object }>;

const secretOperationTimeoutMs = 5000;
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
  return {
    push(message: unknown) {
      if (ended) return;
      const line = JSON.stringify(message);
      if (waiting) {
        const resolve = waiting;
        waiting = undefined;
        resolve({ done: false, value: line });
      } else {
        queued.push(line);
      }
    },
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

async function withinTimeout(work: () => MaybePromise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("timed out"));
    }, secretOperationTimeoutMs);
  });
  try {
    await Promise.race([Promise.resolve().then(work), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

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
      const { status, body } = await respond();
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
      if (!running || !subscriptions.has(name) || !allows("events", name))
        return;
      const delivered = adoptLater();
      deliveries.push(delivered.adopt);
      toPlugin.push(notification(methods.event, { name, data }));
      await delivered.promise;
    },
    async stop() {
      if (!run) return;
      toPlugin.push(notification(methods.shutdown));
      await run.catch(() => undefined);
      toPlugin.end();
    },
    logs,
    calls,
  };
}
