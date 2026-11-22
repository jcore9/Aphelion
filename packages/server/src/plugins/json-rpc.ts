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
} as const satisfies Record<string, RpcError>;

export type RpcId = string | number;

const version = z.literal("2.0");
const id = z.union([z.string().max(128), z.int()]);
const method = z.string().min(1).max(128);
const errorObject = z.object({
  code: z.int(),
  message: z.string().max(4096),
  data: z.unknown().optional(),
});

const incomingSchema = z.union([
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

export type Incoming =
  | {
      readonly kind: "request";
      readonly id: RpcId;
      readonly method: string;
      readonly params: unknown;
    }
  | { readonly kind: "notification"; readonly method: string }
  | { readonly kind: "result"; readonly id: RpcId }
  | { readonly kind: "error"; readonly id: RpcId | null }
  | { readonly kind: "invalid"; readonly error: RpcError };

function parseJson(line: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    return { ok: false };
  }
}

export function parseIncoming(line: string): Incoming {
  const json = parseJson(line);
  if (!json.ok) return { kind: "invalid", error: rpcErrors.parse };
  const parsed = incomingSchema.safeParse(json.value);
  if (!parsed.success) {
    return { kind: "invalid", error: rpcErrors.invalidRequest };
  }
  const message = parsed.data;
  if ("method" in message) {
    return "id" in message
      ? {
          kind: "request",
          id: message.id,
          method: message.method,
          params: message.params,
        }
      : { kind: "notification", method: message.method };
  }
  return "result" in message
    ? { kind: "result", id: message.id }
    : { kind: "error", id: message.id };
}

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
