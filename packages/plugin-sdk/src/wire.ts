import { z } from "zod";

export interface RpcError {
  readonly code: number;
  readonly message: string;
}

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

export const methods = {
  initialize: "initialize",
  event: "event",
  shutdown: "shutdown",
  subscribe: "events.subscribe",
  networkGet: "network.get",
  secretsUse: "secrets.use",
} as const;

export type RpcId = string | number;

const version = z.literal("2.0");
const id = z.union([z.string().max(128), z.int()]);
const method = z.string().min(1).max(128);
const errorObject = z.object({
  code: z.int(),
  message: z.string().max(4096),
  data: z.unknown().optional(),
});

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

export type RpcMessage = z.infer<typeof rpcMessageSchema>;

export const initializeParams = z.object({
  api: z.string(),
  plugin: z.string(),
});
export const eventParams = z.object({
  name: z.string(),
  data: z.unknown(),
});
export const subscribeParams = z.strictObject({ event: z.string().max(128) });
export const networkGetParams = z.strictObject({ url: z.string().max(4096) });
export const networkReply = z.object({ status: z.int(), body: z.string() });
export const secretsUseParams = z.strictObject({
  operation: z.string().max(128),
  reference: z.string().max(1024),
});

export const request = (id: RpcId, method: string, params: unknown) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

export const notification = (method: string, params?: unknown) =>
  params === undefined
    ? { jsonrpc: "2.0", method }
    : { jsonrpc: "2.0", method, params };

export const success = (id: RpcId, result: unknown) => ({
  jsonrpc: "2.0",
  id,
  result,
});

export const failure = (id: RpcId | null, error: RpcError) => ({
  jsonrpc: "2.0",
  id,
  error,
});

const ipv4 = /^\d+\.\d+\.\d+\.\d+$/;

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
