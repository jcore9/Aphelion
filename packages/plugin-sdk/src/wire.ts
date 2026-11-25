import { z } from "zod";

/** A JSON-RPC error object. */
export interface RpcError {
  /** The error code, such as `-32001`. */
  readonly code: number;
  /** A short text that says what went wrong, such as `Not granted`. */
  readonly message: string;
}

/**
 * The errors that the host replies with, by name.
 * [The plugin reference](https://github.com/jcore9/Aphelion/blob/dev/docs/reference/plugins.md#errors) says when the host sends each one.
 */
export const rpcErrors = {
  parse: { code: -32700, message: "Parse error" },
  invalidRequest: { code: -32600, message: "Invalid request" },
  methodNotFound: { code: -32601, message: "Method not found" },
  invalidParams: { code: -32602, message: "Invalid params" },
  notGranted: { code: -32001, message: "Not granted" },
  noSecretOperations: {
    code: -32002,
    message: "The host doesn't offer secret operations yet",
  },
  operationFailed: { code: -32003, message: "Operation failed" },
  busy: { code: -32004, message: "Operation in progress" },
} as const satisfies Record<string, RpcError>;

/** The most UTF-8 bytes one JSON line may hold, not counting the newline. The limit is 1 MiB. */
export const maxPluginLineBytes = 1024 * 1024;

const utf8 = new TextEncoder();

/** Whether `line`, without its newline, fits in `maxPluginLineBytes` as UTF-8. */
export function pluginLineFits(line: string): boolean {
  return utf8.encode(line).byteLength <= maxPluginLineBytes;
}

/** The JSON-RPC method names that the host and a plugin send. */
export const methods = {
  initialize: "initialize",
  event: "event",
  shutdown: "shutdown",
  subscribe: "events.subscribe",
  networkGet: "network.get",
  secretsUse: "secrets.use",
} as const;

/** The id of a JSON-RPC request. A reply carries the id of its request. */
export type RpcId = string | number;

const version = z.literal("2.0");
const id = z.union([z.string().max(128), z.int()]);
const method = z.string().min(1).max(128);
const errorObject = z.object({
  code: z.int(),
  message: z.string().max(4096),
  data: z.unknown().optional(),
});

/** The Zod schema for one JSON-RPC 2.0 message: a request, a notification, a success reply or an error reply. It refuses a field that the message type doesn't have. */
export const rpcMessageSchema = z.union([
  z.strictObject({
    jsonrpc: version,
    id,
    method,
    params: z.unknown().optional(),
  }),
  z.strictObject({ jsonrpc: version, method, params: z.unknown().optional() }),
  z.strictObject({ jsonrpc: version, id, result: z.unknown() }),
  z.strictObject({ jsonrpc: version, id: id.nullable(), error: errorObject }),
]);

/** One JSON-RPC 2.0 message that `rpcMessageSchema` accepted. */
export type RpcMessage = z.infer<typeof rpcMessageSchema>;

/** The Zod schema for the params of the host's `initialize` request. */
export const initializeParams = z.object({
  api: z.string(),
  plugin: z.string(),
});
/** The Zod schema for the params of the host's `event` notification. */
export const eventParams = z.object({
  name: z.string(),
  data: z.unknown(),
});
/** The Zod schema for the params of `events.subscribe`. The event name is at most 128 characters. */
export const subscribeParams = z.strictObject({ event: z.string().max(128) });
/** The Zod schema for the params of `network.get`. The URL is at most 4096 characters. */
export const networkGetParams = z.strictObject({ url: z.string().max(4096) });
/** The Zod schema for the result of `network.get`. */
export const networkReply = z.object({ status: z.int(), body: z.string() });
/** The Zod schema for the params of `secrets.use`. The operation name is at most 128 characters, and the reference at most 1024. */
export const secretsUseParams = z.strictObject({
  operation: z.string().max(128),
  reference: z.string().max(1024),
});

/** Builds a JSON-RPC request. */
export const request = (id: RpcId, method: string, params: unknown) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

/** Builds a JSON-RPC notification. It leaves out `params` when they are `undefined`. */
export const notification = (method: string, params?: unknown) =>
  params === undefined
    ? { jsonrpc: "2.0", method }
    : { jsonrpc: "2.0", method, params };

/** Builds a JSON-RPC success reply. */
export const success = (id: RpcId, result: unknown) => ({
  jsonrpc: "2.0",
  id,
  result,
});

/** Builds a JSON-RPC error reply. The id is `null` when the request couldn't be read. */
export const failure = (id: RpcId | null, error: RpcError) => ({
  jsonrpc: "2.0",
  id,
  error,
});

const ipv4 = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * Checks a URL's form for `network.get`, and returns the URL, or `undefined` if the form is wrong.
 * The URL must use `https:`, a hostname with a dot and no dot at the end, and the default port, with no user name, password or text after a `#`, and not an IP address. `network.get` also refuses a URL longer than 4096 characters and a host that isn't granted.
 */
export function requestUrl(text: string): URL | undefined {
  const url = URL.parse(text);
  if (
    url?.protocol === "https:" &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.hash &&
    !ipv4.test(url.hostname) &&
    !url.hostname.startsWith("[") &&
    url.hostname.includes(".") &&
    !url.hostname.endsWith(".")
  ) {
    return url;
  }
  return undefined;
}
