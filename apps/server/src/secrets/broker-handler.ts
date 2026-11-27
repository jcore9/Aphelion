import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { openLocalStore } from "./local-store";
import { parseSecretReference } from "./reference";
import { Secret } from "./secret";

const maxRequestBytes = 64 * 1024;
const requestSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("read"), ref: z.string() }),
  z.strictObject({
    op: z.literal("write"),
    ref: z.string(),
    value: z.string(),
  }),
  z.strictObject({ op: z.literal("delete"), ref: z.string() }),
]);

export async function handleBrokerRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: Awaited<ReturnType<typeof openLocalStore>>,
): Promise<void> {
  response.setHeader("Connection", "close");
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "POST" || request.url !== "/v1/local") {
    response.writeHead(404).end();
    return;
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Unexpected request encoding");
    bytes += chunk.length;
    if (bytes > maxRequestBytes) {
      request.destroy();
      return;
    }
    chunks.push(chunk);
  }

  let input: unknown;
  try {
    input = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    response.writeHead(400).end();
    return;
  }
  const parsed = requestSchema.safeParse(input);
  const ref = parsed.success && parseSecretReference(parsed.data.ref);
  if (!parsed.success || !ref || !ref.ok || ref.reference.scheme !== "local") {
    response.writeHead(400).end();
    return;
  }

  if (parsed.data.op === "write") {
    const secret = Secret.make(parsed.data.value);
    try {
      await store.write(ref.reference.path, secret);
    } finally {
      secret.wipe();
    }
    response.writeHead(204).end();
    return;
  }

  if (parsed.data.op === "delete") {
    const deleted = await store.delete(ref.reference.path);
    response.writeHead(deleted ? 204 : 404).end();
    return;
  }

  const secret = await store.read(ref.reference.path);
  if (!secret) {
    response.writeHead(404).end();
    return;
  }
  try {
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(secret.reveal()));
  } finally {
    secret.wipe();
  }
}
