import { describe, expect, test } from "vitest";
import { createLogger, type Fields } from "./logger";
import { REDACTED, redactSelf } from "./redact";

function logLine(fields: Fields, msg = "event"): string {
  const lines: string[] = [];
  createLogger({ write: (line) => lines.push(line) }).info(msg, fields);
  expect(lines).toHaveLength(1);
  return lines[0] ?? "";
}

const pem = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
  "-----END PRIVATE KEY-----",
].join("\n");
const jwt =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZGEiLCJpYXQiOjE3MDB9.c2lnbmF0dXJlc2lnbmF0dXJl";

interface Case {
  readonly name: string;
  readonly fields: Fields;
  readonly secret: string;
  readonly kept: string;
  readonly msg?: string;
}

const byFieldName: Case[] = [
  {
    name: "a top-level token",
    fields: { token: "plain-value-1", tokenCount: 7 },
    secret: "plain-value-1",
    kept: '"tokenCount":7',
  },
  {
    name: "a header in a nested object",
    fields: {
      request: {
        headers: { authorization: "plain-value-2", accept: "text/html" },
      },
    },
    secret: "plain-value-2",
    kept: '"accept":"text/html"',
  },
  {
    name: "a password inside an array",
    fields: { users: [{ password: "plain-value-3", label: "ada" }] },
    secret: "plain-value-3",
    kept: '"label":"ada"',
  },
  {
    name: "camelCase, snake_case and kebab-case names",
    fields: {
      accessToken: "plain-value-4a",
      refresh_token: "plain-value-4b",
      "x-api-key": "plain-value-4c",
      APIKey: "plain-value-4d",
      secretAccessKey: "plain-value-4e",
      "set-cookie": "plain-value-4f",
      inputTokens: 1200,
      secretRef: "op://vault/item",
      cacheKey: "agents:list",
    },
    secret: "plain-value-4",
    kept: '"inputTokens":1200,"secretRef":"op://vault/item","cacheKey":"agents:list"',
  },
  {
    name: "a whole object under a sensitive name",
    fields: { credentials: { user: "plain-value-5" }, user: "ada" },
    secret: "plain-value-5",
    kept: '"user":"ada"',
  },
];

const byValuePattern: Case[] = [
  {
    name: "a bearer token inside a string",
    fields: { header: "Bearer abc123def456ghi", note: "the bearer of news" },
    secret: "abc123def456ghi",
    kept: "the bearer of news",
  },
  {
    name: "a basic credential",
    fields: { header: "Basic YWRhOmh1bnRlcjI=", note: "Basic setup" },
    secret: "YWRhOmh1bnRlcjI",
    kept: "Basic setup",
  },
  {
    name: "a password in a URL",
    fields: {
      url: "https://ada:hunter2pw@example.com/repo",
      plain: "https://ada@example.com/repo",
    },
    secret: "hunter2pw",
    kept: "https://ada@example.com/repo",
  },
  {
    name: "an Anthropic key in a sentence",
    fields: { note: "using sk-ant-api03-abcdefghijklmnopqrstuv now" },
    secret: "abcdefghijklmnopqrstuv",
    kept: "using [REDACTED] now",
  },
  {
    name: "an OpenAI key, next to a short sk- word",
    fields: { note: "sk-proj-abcdefghijklmnopqrstuvwx sk-learn" },
    secret: "abcdefghijklmnopqrstuvwx",
    kept: "sk-learn",
  },
  {
    name: "an xAI key",
    fields: { note: "xai-abcdefghijklmnopqrstuvwxyz" },
    secret: "abcdefghijklmnopqrstuvwxyz",
    kept: REDACTED,
  },
  {
    name: "a GitHub token, next to a short ghp_ word",
    fields: { note: "ghp_abcdefghijklmnopqrstuvwxyz0123456789 ghp_short" },
    secret: "abcdefghijklmnopqrstuvwxyz0123456789",
    kept: "ghp_short",
  },
  {
    name: "a fine-grained GitHub token",
    fields: { note: "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz" },
    secret: "11ABCDEFG0abcdefghijklmnopqrstuvwxyz",
    kept: REDACTED,
  },
  {
    name: "a 1Password service account token",
    fields: { note: "ops_eyJzaWduSW5BZGRyZXNzIjoibXkuMXBhc3N3b3JkLmNvbSJ9" },
    secret: "eyJzaWduSW5BZGRyZXNzIjoibXkuMXBhc3N3b3JkLmNvbSJ9",
    kept: REDACTED,
  },
  {
    name: "a Slack token",
    fields: { note: "xoxb-1234567890-abcdefghij" },
    secret: "1234567890-abcdefghij",
    kept: REDACTED,
  },
  {
    name: "an AWS access key ID, next to a short AKIA word",
    fields: { note: "AKIAIOSFODNN7EXAMPLE AKIA123" },
    secret: "IOSFODNN7EXAMPLE",
    kept: "AKIA123",
  },
  {
    name: "an age secret key",
    fields: { note: `AGE-SECRET-KEY-1${"Q".repeat(58)}` },
    secret: "Q".repeat(58),
    kept: REDACTED,
  },
  {
    name: "a JSON Web Token, next to a dotted name",
    fields: { note: `${jwt} eyJ.config.json` },
    secret: "c2lnbmF0dXJlc2lnbmF0dXJl",
    kept: "eyJ.config.json",
  },
  {
    name: "a PEM private key, next to a public key",
    fields: { key: pem, cert: "-----BEGIN PUBLIC KEY-----" },
    secret: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
    kept: "-----BEGIN PUBLIC KEY-----",
  },
  {
    name: "a key in the message itself",
    msg: "pushed with ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    fields: {},
    secret: "abcdefghijklmnopqrstuvwxyz0123456789",
    kept: '"msg":"pushed with [REDACTED]"',
  },
];

describe.each([
  ["by field name", byFieldName],
  ["by value pattern", byValuePattern],
])("redacts %s", (_kind, cases) => {
  test.each(cases)("$name", ({ fields, secret, kept, msg }) => {
    const line = logLine(fields, msg);
    expect(line).not.toContain(secret);
    expect(line).toContain(kept);
  });
});

describe("errors", () => {
  test("redacts the message, the stack and every cause, and keeps the rest", () => {
    const root = new Error("connect refused for Bearer root0123456789");
    const middle = new Error("retry failed", { cause: root });
    const error = Object.assign(
      new Error("push failed with ghp_abcdefghijklmnopqrstuvwxyz0123456789", {
        cause: middle,
      }),
      { code: "EPUSH", token: "plain-error-token" },
    );
    const line = logLine({ error });
    const logged = JSON.parse(line) as {
      error: {
        message: string;
        stack: string;
        code: string;
        token: string;
        cause: { message: string; cause: { message: string } };
      };
    };

    for (const secret of [
      "abcdefghijklmnopqrstuvwxyz0123456789",
      "root0123456789",
      "plain-error-token",
    ]) {
      expect(line).not.toContain(secret);
    }
    expect(logged.error.message).toBe("push failed with [REDACTED]");
    expect(logged.error.stack).toContain("push failed with [REDACTED]");
    expect(logged.error.code).toBe("EPUSH");
    expect(logged.error.token).toBe(REDACTED);
    expect(logged.error.cause.message).toBe("retry failed");
    expect(logged.error.cause.cause.message).toBe(
      "connect refused for Bearer [REDACTED]",
    );
  });

  test("redacts each error inside an AggregateError", () => {
    const error = new AggregateError(
      [
        new Error("bad key xai-abcdefghijklmnopqrstuvwxyz"),
        new Error("timeout"),
      ],
      "two failed",
    );
    const line = logLine({ error });

    expect(line).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(line).toContain("bad key [REDACTED]");
    expect(line).toContain('"message":"timeout"');
    expect(line).toContain('"message":"two failed"');
  });
});

describe("values that redact themselves", () => {
  class Wrapped {
    readonly #value: string;
    constructor(value: string) {
      this.#value = value;
    }
    reveal(): string {
      return this.#value;
    }
    [redactSelf](): string {
      return "[secret op://vault/item]";
    }
  }

  test("are replaced by what they return, wherever they sit", () => {
    const secret = new Wrapped("plain-self-secret");
    const line = logLine({ config: { harmless: secret }, list: [secret] });

    expect(secret.reveal()).toBe("plain-self-secret");
    expect(line).not.toContain("plain-self-secret");
    expect(JSON.parse(line)).toMatchObject({
      config: { harmless: "[secret op://vault/item]" },
      list: ["[secret op://vault/item]"],
    });
  });

  test("need only the shared symbol, not an import from the server", () => {
    const value = {
      inner: "plain-foreign-secret",
      [Symbol.for("aphelion.redactSelf")]: () => "[foreign secret]",
    };
    const line = logLine({ value, other: { inner: "kept-inner" } });

    expect(line).not.toContain("plain-foreign-secret");
    expect(line).toContain('"value":"[foreign secret]"');
    expect(line).toContain('"inner":"kept-inner"');
  });
});

describe("other values", () => {
  test("uses toJSON, so a URL's password and a Date are handled", () => {
    const line = logLine({
      url: new URL("https://ada:hunter2pw@example.com/"),
      at: new Date("2026-11-22T10:00:00.000Z"),
    });

    expect(line).not.toContain("hunter2pw");
    expect(line).toContain('"url":"https://ada:[REDACTED]@example.com/"');
    expect(line).toContain('"at":"2026-11-22T10:00:00.000Z"');
  });

  test("logs bytes by length and bigints as strings", () => {
    const line = logLine({
      body: new TextEncoder().encode("plain-bytes"),
      size: 12345678901234567890n,
    });

    expect(line).toContain('"body":"[11 bytes]"');
    expect(line).toContain('"size":"12345678901234567890"');
  });

  test("marks a cycle instead of throwing, and logs a shared object twice", () => {
    const shared = { name: "shared" };
    const cyclic: Record<string, unknown> = { name: "loop", shared };
    cyclic["self"] = cyclic;
    const line = logLine({ cyclic, again: shared });

    expect(JSON.parse(line)).toMatchObject({
      cyclic: { name: "loop", shared: { name: "shared" }, self: "[Circular]" },
      again: { name: "shared" },
    });
  });
});
