import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { generateIdentity } from "age-encryption";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleBrokerRequest } from "./broker-handler";
import { openLocalStore } from "./local-store";
import { Secret } from "./secret";

const canary = "sk-ant-fake-broker-handler-canary-0123456789";

let root: string;
let store: Awaited<ReturnType<typeof openLocalStore>>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aphelion-broker-handler-"));
  await mkdir(join(root, "store"), { mode: 0o700 });
  store = await openLocalStore(
    join(root, "store"),
    Secret.make(await generateIdentity()),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function handle(chunks: readonly Buffer[]) {
  const request = Object.assign(Readable.from(chunks), {
    method: "POST",
    url: "/v1/local",
  }) as unknown as IncomingMessage;
  let status: number | undefined;
  const response = {
    setHeader: () => response,
    writeHead: (code: number) => {
      status = code;
      return response;
    },
    end: () => response,
  } as unknown as ServerResponse;
  await handleBrokerRequest(request, response, store);
  return status;
}

const zeroed = (chunks: readonly Buffer[]) =>
  chunks.every((chunk) => chunk.every((byte) => byte === 0));

describe("handleBrokerRequest", () => {
  it("zeroes the request bytes of a write once it parsed them", async () => {
    const body = JSON.stringify({
      op: "write",
      ref: "local://apikey/claude",
      value: canary,
    });
    const chunks = [
      Buffer.from(body.slice(0, 40)),
      Buffer.from(body.slice(40)),
    ];
    expect(await handle(chunks)).toBe(204);
    expect(zeroed(chunks)).toBe(true);
    const stored = await store.read("apikey/claude");
    try {
      expect(stored?.reveal()).toBe(canary);
    } finally {
      stored?.wipe();
    }
  });

  it("zeroes the request bytes of a request it refuses as too long", async () => {
    const chunks = [
      Buffer.from(`{"op":"write","value":"${canary}`.padEnd(40_000, "k")),
      Buffer.alloc(40_000, "k"),
    ];
    expect(await handle(chunks)).toBeUndefined();
    expect(zeroed(chunks)).toBe(true);
  });

  it("zeroes the request bytes of a request that isn't JSON", async () => {
    const chunks = [Buffer.from(`{"op":"write","value":"${canary}`)];
    expect(await handle(chunks)).toBe(400);
    expect(zeroed(chunks)).toBe(true);
  });
});
