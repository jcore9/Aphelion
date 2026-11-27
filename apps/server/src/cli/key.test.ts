import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity } from "age-encryption";
import { Cause, Effect, Exit, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiKeyFromInput } from "../secrets/api-key";
import { brokerClient, type BrokerClient } from "../secrets/broker-client";
import { handleBrokerRequest } from "../secrets/broker-handler";
import { openLocalStore } from "../secrets/local-store";
import { Secret } from "../secrets/secret";
import { openStore } from "../store";
import { databaseFile } from "./device";
import { CliFailure } from "./failure";
import { CliIo } from "./io";
import { keyAdd, keyRemove, keyReplace, keyTest } from "./key";

const fake = "sk-ant-fake-key-cli-canary-0123456789abcdef";
const other = "sk-ant-fake-key-cli-other-fedcba9876543210";

let root: string;
let stateDir: string;
let storeDir: string;
let broker: BrokerClient;
let brokerServer: Server;
let provider: Server;
let answer: () => number;
let seen: IncomingHttpHeaders[];
let printed: string[];

const listen = (server: Server, where: string | number) =>
  new Promise<void>((resolve) => {
    if (typeof where === "string") server.listen(where, resolve);
    else server.listen(where, "127.0.0.1", resolve);
  });
const close = (server: Server) =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
const providerUrl = () =>
  `http://127.0.0.1:${String((provider.address() as AddressInfo).port)}`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aphelion-key-cli-"));
  stateDir = join(root, "state");
  storeDir = join(root, "secrets");
  await mkdir(stateDir, { mode: 0o700 });
  await mkdir(storeDir, { mode: 0o700 });
  const store = await openLocalStore(
    storeDir,
    Secret.make(await generateIdentity()),
  );
  const socket = join(root, "broker.sock");
  brokerServer = createServer((request, response) => {
    void handleBrokerRequest(request, response, store);
  });
  await listen(brokerServer, socket);
  broker = brokerClient(socket);
  answer = () => 200;
  seen = [];
  provider = createServer((request, response) => {
    seen.push(request.headers);
    const status = answer();
    if (status === 0) return;
    response.writeHead(status, { location: "http://127.0.0.1:1/" });
    response.end(`{"error":"${fake}"}`);
  });
  await listen(provider, 0);
  printed = [];
});

afterEach(async () => {
  const rows = audit().map((row) => JSON.stringify(row));
  const store = await Promise.all(
    (await readdir(storeDir)).map((file) =>
      readFile(join(storeDir, file), "latin1"),
    ),
  );
  for (const text of [...printed, ...rows, ...store]) {
    expect(text).not.toContain(fake);
    expect(text).not.toContain(other);
  }
  await close(provider);
  await close(brokerServer);
  await rm(root, { recursive: true, force: true });
});

function audit() {
  const db = openStore(join(stateDir, databaseFile));
  try {
    return db
      .all(
        "SELECT actor_kind, action, outcome, detail FROM audit_log ORDER BY id",
      )
      .map((row) => ({
        ...row,
        detail: JSON.parse(String(row["detail"])) as unknown,
      }));
  } finally {
    db.close();
  }
}

async function capture(
  program: Effect.Effect<unknown, unknown, CliIo>,
  input?: string,
) {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const io = Layer.succeed(CliIo, {
    out: (line) => Effect.sync(() => void out.push(line)),
    err: (line) => Effect.sync(() => void err.push(line)),
    stdin: Effect.die("key commands read the key with readApiKey"),
    readApiKey: (prompt) =>
      Effect.sync(() => {
        prompts.push(prompt);
        if (input === undefined) throw new Error("read a key it shouldn't");
        return apiKeyFromInput(new TextEncoder().encode(input));
      }),
  });
  const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(io)));
  let code = 0;
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause);
    code = error instanceof CliFailure ? error.exitCode : -1;
    printed.push(String(error));
  }
  printed.push(...out, ...err, ...prompts);
  return { code, out, err, prompts };
}

const add = (input?: string, tool = "claude" as const) =>
  capture(keyAdd({ stateDir, tool }, broker), input);
const replace = (input?: string) =>
  capture(keyReplace({ stateDir, tool: "claude" }, broker), input);
const remove = () => capture(keyRemove({ stateDir, tool: "claude" }, broker));
const check = (tool: "claude" | "codex" = "claude", timeoutMs?: number) =>
  capture(
    keyTest({ stateDir, tool, testUrl: providerUrl() }, broker, timeoutMs),
  );

const stored = async () => {
  const secret = await broker.read("local://apikey/claude");
  try {
    return secret?.reveal();
  } finally {
    secret?.wipe();
  }
};

describe("aphelion key add", () => {
  it("stores the key from standard input and says how to test it", async () => {
    expect(await add(`${fake}\n`)).toEqual({
      code: 0,
      out: [
        "Stored the claude API key. Test it with: aphelion key test claude",
      ],
      err: [],
      prompts: ["API key for claude (an Anthropic API key): "],
    });
    expect(await stored()).toBe(fake);
    expect(audit()).toEqual([
      {
        actor_kind: "cli",
        action: "key.add",
        outcome: "succeeded",
        detail: { tool: "claude", result: "stored" },
      },
    ]);
  });

  it("refuses when a key is already stored, before it reads a key", async () => {
    await add(fake);
    const second = await add();
    expect(second.code).toBe(1);
    expect(second.err).toEqual([
      "An API key for claude is already stored. To change it, run: aphelion key replace claude",
    ]);
    expect(second.prompts).toEqual([]);
    expect(await stored()).toBe(fake);
    expect(audit().at(-1)).toMatchObject({
      action: "key.add",
      outcome: "failed",
      detail: { tool: "claude", result: "already stored" },
    });
  });

  it.each([
    ["", "The API key is empty."],
    [
      `${fake}\n${other}\n`,
      "The API key has a line break or a control character.",
    ],
    ["k".repeat(600), "The API key is longer than 512 bytes."],
  ])(
    "refuses input %#, stores nothing and never repeats it",
    async (input, reason) => {
      const result = await add(input);
      expect(result.code).toBe(1);
      expect(result.out).toEqual([]);
      expect(result.err).toEqual([reason]);
      expect(await stored()).toBeUndefined();
      expect(audit().at(-1)).toMatchObject({
        action: "key.add",
        outcome: "failed",
        detail: { tool: "claude", result: "input refused" },
      });
    },
  );

  it("names the vendor in the prompt for each tool", async () => {
    expect((await add(fake, "codex" as "claude")).prompts).toEqual([
      "API key for codex (an OpenAI API key): ",
    ]);
  });
});

describe("aphelion key replace", () => {
  it("replaces a stored key", async () => {
    await add(fake);
    expect(await replace(other)).toEqual({
      code: 0,
      out: [
        "Replaced the claude API key. Test it with: aphelion key test claude",
      ],
      err: [],
      prompts: ["API key for claude (an Anthropic API key): "],
    });
    expect(await stored()).toBe(other);
    expect(audit().at(-1)).toMatchObject({
      action: "key.replace",
      outcome: "succeeded",
      detail: { tool: "claude", result: "replaced" },
    });
  });

  it("refuses when no key is stored, before it reads a key", async () => {
    const result = await replace();
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      "No API key is stored for claude. Add one with: aphelion key add claude",
    ]);
    expect(result.prompts).toEqual([]);
    expect(await stored()).toBeUndefined();
    expect(audit().at(-1)).toMatchObject({
      action: "key.replace",
      outcome: "failed",
      detail: { tool: "claude", result: "not stored" },
    });
  });
});

describe("aphelion key remove", () => {
  it("removes a stored key", async () => {
    await add(fake);
    expect(await remove()).toEqual({
      code: 0,
      out: ["Removed the claude API key."],
      err: [],
      prompts: [],
    });
    expect(await stored()).toBeUndefined();
    expect(audit().at(-1)).toMatchObject({
      action: "key.remove",
      outcome: "succeeded",
      detail: { tool: "claude", result: "removed" },
    });
  });

  it("exits 1 when no key is stored", async () => {
    const result = await remove();
    expect(result.code).toBe(1);
    expect(result.err).toEqual(["No API key is stored for claude."]);
    expect(audit().at(-1)).toMatchObject({
      action: "key.remove",
      outcome: "failed",
      detail: { tool: "claude", result: "not stored" },
    });
  });
});

describe("aphelion key test", () => {
  it("passes when the provider accepts the key", async () => {
    await add(fake);
    expect(await check()).toEqual({
      code: 0,
      out: ["The provider accepted the claude API key."],
      err: [],
      prompts: [],
    });
    expect(seen[0]?.["x-api-key"]).toBe(fake);
    expect(audit().at(-1)).toMatchObject({
      action: "key.test",
      outcome: "succeeded",
      detail: { tool: "claude", result: "accepted" },
    });
  });

  it.each([
    [
      401,
      "The provider refused the claude API key. To change it, run: aphelion key replace claude",
      { result: "refused" },
    ],
    [
      403,
      "The provider refused the claude API key. To change it, run: aphelion key replace claude",
      { result: "refused" },
    ],
    [
      302,
      "The provider answered HTTP 302, so the claude API key wasn't checked.",
      { result: "answered", status: 302 },
    ],
    [
      500,
      "The provider answered HTTP 500, so the claude API key wasn't checked.",
      { result: "answered", status: 500 },
    ],
  ])("fails on HTTP %i with a fixed line", async (status, line, detail) => {
    await add(fake);
    answer = () => status;
    const result = await check();
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err).toEqual([line]);
    expect(audit().at(-1)).toMatchObject({
      action: "key.test",
      outcome: "failed",
      detail: { tool: "claude", ...detail },
    });
  });

  it("fails with a fixed line when the provider doesn't answer in time", async () => {
    await add(fake);
    answer = () => 0;
    const result = await check("claude", 200);
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      "Couldn't reach the provider, or it didn't answer within 10 seconds.",
    ]);
    expect(audit().at(-1)).toMatchObject({
      detail: { tool: "claude", result: "unreachable" },
    });
  });

  it("exits 1 without asking the provider when no key is stored", async () => {
    const result = await check("codex");
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      "No API key is stored for codex. Add one with: aphelion key add codex",
    ]);
    expect(seen).toEqual([]);
  });
});

describe("an audit log that can't be written", () => {
  it("still prints the refusal", async () => {
    const result = await capture(
      keyRemove(
        { stateDir: join(root, "missing", "state"), tool: "claude" },
        broker,
      ),
    );
    expect(result.code).not.toBe(0);
    expect(result.err[0]).toBe("No API key is stored for claude.");
  });
});

describe("a broker that can't be reached", () => {
  it("fails with a fixed line and an audit row", async () => {
    const away = brokerClient(join(root, "missing.sock"));
    const result = await capture(keyRemove({ stateDir, tool: "grok" }, away));
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      `can't reach the secrets broker at ${join(root, "missing.sock")}`,
    ]);
    expect(audit().at(-1)).toMatchObject({
      action: "key.remove",
      outcome: "failed",
      detail: { tool: "grok", result: "broker error" },
    });
  });
});
