import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apiKeyFromInput,
  apiKeyRef,
  apiKeyTools,
  checkApiKey,
  providers,
} from "./api-key";
import { parseSecretReference } from "./reference";
import { Secret } from "./secret";

const fake = "sk-fake-api-key-canary-0123456789abcdef";

describe("apiKeyFromInput", () => {
  const input = (text: string) => new TextEncoder().encode(text);

  it.each([
    [fake, fake],
    [`${fake}\n`, fake],
    [`${fake}\r\n`, fake],
    [`${fake}\r`, fake],
    ["k".repeat(512), "k".repeat(512)],
  ])("wraps %j in a Secret", (text, expected) => {
    const result = apiKeyFromInput(input(text));
    if (!result.ok) throw new Error(result.reason);
    try {
      expect(result.key).toBeInstanceOf(Secret);
      expect(result.key.reveal()).toBe(expected);
    } finally {
      result.key.wipe();
    }
  });

  it.each([
    ["", "The API key is empty."],
    ["\n", "The API key is empty."],
    [`${fake}\n\n`, "The API key has a line break or a control character."],
    [`${fake}\nsecond`, "The API key has a line break or a control character."],
    [`${fake}\t`, "The API key has a line break or a control character."],
    [`${fake}\u007f`, "The API key has a line break or a control character."],
    [`${fake} `, "The API key has a line break or a control character."],
    [`sk fake`, "The API key has a line break or a control character."],
    [`${fake}\u0085`, "The API key has a line break or a control character."],
    [`${fake}\u009b`, "The API key has a line break or a control character."],
    [`${fake}\u00e9`, "The API key has a line break or a control character."],
    [`${fake}\u200b`, "The API key has a line break or a control character."],
    ["k".repeat(513), "The API key is longer than 512 bytes."],
  ])("refuses %j without repeating it", (text, reason) => {
    const result = apiKeyFromInput(input(text));
    expect(result).toEqual({ ok: false, reason });
    if (!result.ok) expect(result.reason).not.toContain(fake);
  });

  it("refuses bytes that aren't printable ASCII", () => {
    expect(apiKeyFromInput(new Uint8Array([0x6b, 0xff, 0x6b]))).toEqual({
      ok: false,
      reason: "The API key has a line break or a control character.",
    });
  });

  it("takes every printable ASCII character", () => {
    const printable = String.fromCharCode(
      ...Array.from({ length: 0x7e - 0x21 + 1 }, (_, index) => 0x21 + index),
    );
    const result = apiKeyFromInput(input(printable));
    if (!result.ok) throw new Error(result.reason);
    try {
      expect(result.key.reveal()).toBe(printable);
    } finally {
      result.key.wipe();
    }
  });

  it("zeroes the input it read", () => {
    const bytes = input(`${fake}\n`);
    const result = apiKeyFromInput(bytes);
    if (result.ok) result.key.wipe();
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });
});

describe("the API key tools", () => {
  it("name a local secret reference for each tool", () => {
    expect(apiKeyTools).toEqual(["claude", "codex", "grok"]);
    for (const tool of apiKeyTools) {
      const parsed = parseSecretReference(apiKeyRef(tool));
      expect(parsed.ok && parsed.reference.scheme).toBe("local");
    }
    expect(apiKeyRef("claude")).toBe("local://apikey/claude");
  });

  it("fix each provider's address in code", () => {
    expect(
      Object.fromEntries(
        apiKeyTools.map((tool) => [tool, providers[tool].baseUrl]),
      ),
    ).toEqual({
      claude: "https://api.anthropic.com",
      codex: "https://api.openai.com",
      grok: "https://api.x.ai",
    });
  });
});

describe("checkApiKey", () => {
  let server: Server;
  let elsewhere: Server;
  let answer: (path: string) => { status: number; location?: string };
  let seen: { path: string; headers: IncomingHttpHeaders }[];
  let elsewhereHits: number;

  const base = (target: Server) =>
    `http://127.0.0.1:${String((target.address() as AddressInfo).port)}`;
  const listen = (target: Server) =>
    new Promise<void>((resolve) => {
      target.listen(0, "127.0.0.1", resolve);
    });

  beforeEach(async () => {
    seen = [];
    elsewhereHits = 0;
    answer = () => ({ status: 200 });
    server = createServer((request, response) => {
      seen.push({ path: request.url ?? "", headers: request.headers });
      const { status, location } = answer(request.url ?? "");
      if (status === 0) return;
      response.writeHead(status, location === undefined ? {} : { location });
      response.end(`{"echo":"${fake}"}`);
    });
    elsewhere = createServer((_request, response) => {
      elsewhereHits += 1;
      response.end();
    });
    await listen(server);
    await listen(elsewhere);
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => elsewhere.close(resolve));
  });

  const check = async (
    tool: (typeof apiKeyTools)[number],
    timeoutMs = 2_000,
  ) => {
    const key = Secret.make(fake);
    try {
      return await checkApiKey(tool, key, { baseUrl: base(server), timeoutMs });
    } finally {
      key.wipe();
    }
  };

  it("asks GET /v1/models with Anthropic's headers for claude", async () => {
    expect(await check("claude")).toEqual({ kind: "accepted" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe("/v1/models");
    expect(seen[0]?.headers["x-api-key"]).toBe(fake);
    expect(seen[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it.each(["codex", "grok"] as const)(
    "asks GET /v1/models with a bearer token for %s",
    async (tool) => {
      expect(await check(tool)).toEqual({ kind: "accepted" });
      expect(seen[0]?.path).toBe("/v1/models");
      expect(seen[0]?.headers.authorization).toBe(`Bearer ${fake}`);
      expect(seen[0]?.headers["x-api-key"]).toBeUndefined();
    },
  );

  it.each([401, 403])(
    "says the provider refused the key on %i",
    async (status) => {
      answer = () => ({ status });
      expect(await check("claude")).toEqual({ kind: "refused" });
    },
  );

  it("gives only the status for any other answer", async () => {
    answer = () => ({ status: 500 });
    expect(await check("codex")).toEqual({ kind: "status", status: 500 });
  });

  it("never follows a redirect, so the key stays with the provider", async () => {
    answer = () => ({ status: 302, location: `${base(elsewhere)}/v1/models` });
    expect(await check("grok")).toEqual({ kind: "status", status: 302 });
    expect(elsewhereHits).toBe(0);
  });

  it("says the provider couldn't be reached when it doesn't answer in time", async () => {
    answer = () => ({ status: 0 });
    expect(await check("claude", 200)).toEqual({ kind: "unreachable" });
  });

  it("says the provider couldn't be reached when nothing listens", async () => {
    const key = Secret.make(fake);
    try {
      expect(
        await checkApiKey("claude", key, { baseUrl: "http://127.0.0.1:1" }),
      ).toEqual({ kind: "unreachable" });
    } finally {
      key.wipe();
    }
  });
});
