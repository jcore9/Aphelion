import type { SecretReference } from "./secret-backend.ts";
import type { RpcError } from "./wire.ts";

export type MaybePromise<T> = T | Promise<T>;

export interface NetworkReply {
  readonly status: number;
  readonly body: string;
}

export interface PluginContext {
  readonly id: string;
  readonly api: string;
  readonly events: {
    subscribe(
      name: string,
      handle: (data: unknown) => MaybePromise<void>,
    ): Promise<void>;
  };
  readonly network: { get(url: string): Promise<NetworkReply> };
  readonly secrets: {
    use(operation: string, reference: SecretReference): Promise<void>;
  };
  log(message: string): void;
}

export type Cleanup = () => MaybePromise<void>;

export interface ServerPlugin {
  start(context: PluginContext): MaybePromise<void> | MaybePromise<Cleanup>;
}

export class HostError extends Error {
  readonly code: number;

  constructor({ code, message }: RpcError) {
    super(message);
    this.name = "HostError";
    this.code = code;
  }
}

export interface PluginIO {
  readonly input: AsyncIterable<string>;
  write(line: string): Promise<void>;
  log(message: string): void;
}
