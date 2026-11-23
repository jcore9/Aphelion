import {
  HostError,
  type Cleanup,
  type MaybePromise,
  type PluginContext,
  type PluginIO,
  type ServerPlugin,
} from "./plugin.ts";
import {
  eventParams,
  failure,
  initializeParams,
  methods,
  networkReply,
  request,
  rpcErrors,
  rpcMessageSchema,
  success,
  type RpcId,
  type RpcMessage,
} from "./wire.ts";

export interface RuntimeHooks {
  readonly started?: (settled: Promise<void>) => void;
  readonly delivered?: (settled: Promise<void>) => void;
}

interface PendingCall {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

type Handler = (data: unknown) => MaybePromise<void>;

export const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function parse(line: string): RpcMessage | undefined {
  try {
    const parsed = rpcMessageSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function runPlugin(plugin: ServerPlugin, io: PluginIO): Promise<void> {
  return serve(plugin, io, {});
}

export async function serve(
  plugin: ServerPlugin,
  io: PluginIO,
  hooks: RuntimeHooks,
): Promise<void> {
  const pending = new Map<RpcId, PendingCall>();
  const handlers = new Map<string, Handler>();
  let interrupt: (() => void) | undefined;
  let nextId = 1;
  let writing = Promise.resolve();
  let exclusive: Promise<unknown> = Promise.resolve();
  let closed = false;
  let failed: { readonly error: unknown } | undefined;
  let started: Promise<void> | undefined;
  let cleanup: Cleanup | undefined;

  let broken: { readonly error: unknown } | undefined;
  const breakOff = (error: unknown) => {
    if (closed) return;
    broken ??= { error };
    interrupt?.();
  };

  const send = (message: unknown) => {
    const line = JSON.stringify(message);
    const sent = writing.then(() => {
      if (broken) throw broken.error;
      if (closed) throw new Error("the plugin is shutting down");
      return io.write(line);
    });
    writing = sent.catch(breakOff);
    return sent;
  };

  const call = async (method: string, params: unknown) => {
    if (closed) throw new Error("the plugin is shutting down");
    const id = nextId++;
    const reply = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    reply.catch(() => undefined);
    try {
      await send(request(id, method, params));
    } catch (error) {
      pending.delete(id);
      throw error;
    }
    return reply;
  };

  const callAlone = (method: string, params: unknown) => {
    const result = exclusive.then(() => call(method, params));
    exclusive = result.catch(() => undefined);
    return result;
  };

  const context = (id: string, api: string): PluginContext => ({
    id,
    api,
    events: {
      async subscribe(name, handle) {
        handlers.set(name, handle);
        try {
          await call(methods.subscribe, { event: name });
        } catch (error) {
          if (handlers.get(name) === handle) handlers.delete(name);
          throw error;
        }
      },
    },
    network: {
      async get(url) {
        const reply = await callAlone(methods.networkGet, { url });
        return networkReply.parse(reply);
      },
    },
    secrets: {
      async use(operation, reference) {
        await callAlone(methods.secretsUse, { operation, reference });
      },
    },
    log: (message) => {
      io.log(message);
    },
  });

  const start = (pluginContext: PluginContext) => {
    const settled = (async () => {
      const result = await plugin.start(pluginContext);
      if (typeof result === "function") cleanup = result;
    })();
    hooks.started?.(settled);
    return settled.catch((error: unknown) => {
      if (closed) {
        io.log(`the plugin's start failed: ${describeError(error)}`);
        return;
      }
      failed = { error };
      interrupt?.();
    });
  };

  const deliver = (params: unknown) => {
    const event = eventParams.safeParse(params);
    const handle = event.success ? handlers.get(event.data.name) : undefined;
    const settled =
      event.success && handle
        ? (async () => {
            await handle(event.data.data);
          })().catch((error: unknown) => {
            io.log(
              `the handler for ${event.data.name} failed: ${describeError(error)}`,
            );
          })
        : Promise.resolve();
    hooks.delivered?.(settled);
  };

  const settle = (
    id: RpcId,
    outcome: { result: unknown } | { error: HostError },
  ) => {
    const waiting = pending.get(id);
    if (!waiting) return;
    pending.delete(id);
    if ("result" in outcome) waiting.resolve(outcome.result);
    else waiting.reject(outcome.error);
  };

  const input = io.input[Symbol.asyncIterator]();
  const read = () =>
    new Promise<IteratorResult<string>>((resolve, reject) => {
      interrupt = () => {
        resolve({ done: true, value: undefined });
      };
      input.next().then(resolve, reject);
    });
  const receive = async () => {
    while (!failed && !broken) {
      const next = await read();
      if (next.done) return;
      const message = parse(next.value);
      if (!message) {
        io.log("the host sent a line that isn't a JSON-RPC message");
        continue;
      }
      if ("method" in message) {
        if ("id" in message) {
          if (message.method === methods.initialize && !started) {
            const params = initializeParams.safeParse(message.params);
            if (!params.success) {
              await send(failure(message.id, rpcErrors.invalidParams));
              continue;
            }
            await send(success(message.id, {}));
            started = start(context(params.data.plugin, params.data.api));
          } else {
            await send(failure(message.id, rpcErrors.methodNotFound));
          }
        } else if (message.method === methods.shutdown) {
          break;
        } else if (message.method === methods.event && started) {
          deliver(message.params);
        }
      } else if ("result" in message) {
        settle(message.id, { result: message.result });
      } else if (message.id !== null) {
        settle(message.id, { error: new HostError(message.error) });
      }
    }
  };

  try {
    await receive();
  } catch (error) {
    breakOff(error);
  }

  closed = true;
  interrupt = undefined;
  void input.return?.();
  for (const waiting of pending.values()) {
    waiting.reject(new Error("the plugin is shutting down"));
  }
  pending.clear();
  await started;
  if (failed) {
    io.log(`the plugin's start failed: ${describeError(failed.error)}`);
    await writing;
    throw failed.error;
  }
  try {
    await cleanup?.();
  } catch (error) {
    io.log(`the plugin's cleanup failed: ${describeError(error)}`);
  }
  await writing;
  if (broken) throw broken.error;
}
