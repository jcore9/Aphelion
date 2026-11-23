import type { SecretReference } from "./secret-backend.ts";
import type { RpcError } from "./wire.ts";

/** A value, or a promise of one. */
export type MaybePromise<T> = T | Promise<T>;

/** The host's reply to `network.get`. */
export interface NetworkReply {
  /** The HTTP status code. */
  readonly status: number;
  /** The response body as text. The host fails a response whose body is larger than 64 KiB. */
  readonly body: string;
}

/** The plugin's connection to the host, which `start` receives. */
export interface PluginContext {
  /** The plugin's `id`, as the host sent it when it started the plugin. */
  readonly id: string;
  /** The plugin API version that the host runs, such as `0.2.1`. */
  readonly api: string;
  /**
   * `subscribe(name, handle)` asks the host for an event, and the SDK then calls `handle` with each event's data.
   * It rejects with a `HostError` when the manifest's `permissions.events` doesn't list the event or the owner hasn't granted it.
   */
  readonly events: {
    subscribe(
      name: string,
      handle: (data: unknown) => MaybePromise<void>,
    ): Promise<void>;
  };
  /**
   * `get(url)` asks the host to fetch an HTTPS URL that `requestUrl` accepts, from a host in `permissions.network` that the owner granted.
   * The SDK sends one network or secret call at a time, so a second call waits until the first one has its reply.
   */
  readonly network: { get(url: string): Promise<NetworkReply> };
  /**
   * `use(operation, reference)` asks the host to run a named operation with a secret, such as a signed HTTP call.
   * The plugin never receives the secret's value or the operation's result, and the call waits its turn like `network.get`.
   * The server offers no secret operations yet, so today a granted call fails with error `-32002`.
   */
  readonly secrets: {
    use(operation: string, reference: SecretReference): Promise<void>;
  };
  /** Writes a message to the plugin's log, which goes to the server's log. */
  log(message: string): void;
}

/** A function that `start` can return. The SDK calls it once when the plugin shuts down, and logs an error if it throws. */
export type Cleanup = () => MaybePromise<void>;

/** A plugin's server part. Pass it to `main` from `@aphelion/plugin-sdk/stdio`. */
export interface ServerPlugin {
  /**
   * The SDK calls `start` once, after it has answered the host's `initialize` request.
   * If `start` throws or rejects, the plugin stops with that error.
   */
  start(context: PluginContext): MaybePromise<void> | MaybePromise<Cleanup>;
}

/** The error that a call to the host rejects with when the host refuses it, such as `Not granted`. */
export class HostError extends Error {
  /** The JSON-RPC error code, such as `-32001`. `rpcErrors` lists every code the host sends. */
  readonly code: number;

  /** Makes the error from the error object in the host's reply. */
  constructor({ code, message }: RpcError) {
    super(message);
    this.name = "HostError";
    this.code = code;
  }
}

/** The lines that `runPlugin` reads and writes. `main` builds one from standard input and output. */
export interface PluginIO {
  /** The host's messages, one JSON line for each item. */
  readonly input: AsyncIterable<string>;
  /** Sends one JSON line to the host, without its line break. The promise settles when the line is written. */
  write(line: string): Promise<void>;
  /** Writes a message to the log. */
  log(message: string): void;
}
