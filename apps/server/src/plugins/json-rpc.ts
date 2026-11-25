import {
  rpcErrors,
  rpcMessageSchema,
  type RpcError,
  type RpcId,
} from "@aphelion/plugin-sdk";

export {
  failure,
  notification,
  request,
  rpcErrors,
  success,
  type RpcError,
  type RpcId,
} from "@aphelion/plugin-sdk";

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
  const parsed = rpcMessageSchema.safeParse(json.value);
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
