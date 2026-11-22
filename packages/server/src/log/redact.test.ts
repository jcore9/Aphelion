import { describe, expect, test } from "vitest";
import { createLogger, type Fields } from "./logger";
import {
  REDACTED,
  redactSelf,
  redactText,
  TOO_DEEP,
  UNREADABLE,
} from "./redact";

function logLine(fields: Fields, msg = "event"): string {
  const lines: string[] = [];
  createLogger({
    write: (line) => lines.push(line),
    now: () => new Date("2026-11-22T10:00:00.000Z"),
  }).info(msg, fields);
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
      ACCESSTOKEN: "plain-value-4g",
      pass: "plain-value-4h",
      pwd: "plain-value-4i",
      inputTokens: 1200,
      secretRef: "op://vault/item",
      cacheKey: "agents:list",
      bypass: true,
    },
    secret: "plain-value-4",
    kept: '"inputTokens":1200,"secretRef":"op://vault/item","cacheKey":"agents:list","bypass":true',
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
    name: "a secret query parameter, next to an ordinary one",
    fields: { url: "https://example.com/cb?access_token=plain-query-1&page=2" },
    secret: "plain-query-1",
    kept: "access_token=[REDACTED]&page=2",
  },
  {
    name: "a secret assignment, next to an ordinary one",
    fields: { command: "GITHUB_TOKEN=plain-env-1 PORT=8080 bun start" },
    secret: "plain-env-1",
    kept: "PORT=8080 bun start",
  },
  {
    name: "a secret field inside a JSON-encoded string",
    fields: { body: '{"user":"ada","password":"plain-json-1"}' },
    secret: "plain-json-1",
    kept: '\\"user\\":\\"ada\\"',
  },
  {
    name: "an OpenAI key, next to a hyphenated slug",
    fields: {
      note: "sk-proj-abcdefghijklmnopqrstuvwx sk-learn sk-this-is-an-ordinary-slug",
    },
    secret: "abcdefghijklmnopqrstuvwx",
    kept: "sk-learn sk-this-is-an-ordinary-slug",
  },
  {
    name: "a legacy OpenAI key",
    fields: { note: "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD" },
    secret: "abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    kept: REDACTED,
  },
  {
    name: "an unterminated PEM private key",
    fields: { key: "-----BEGIN RSA PRIVATE KEY-----\nMIIEplainpemtail" },
    secret: "MIIEplainpemtail",
    kept: REDACTED,
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

describe("hostile values", () => {
  test("reads toJSON once, so a getter can't swap in a function afterwards", () => {
    let reads = 0;
    const tricky = {
      get toJSON() {
        reads += 1;
        return reads === 1
          ? undefined
          : () => "ghp_abcdefghijklmnopqrstuvwxyz0123456789-unredacted";
      },
      label: "kept-label",
    };
    const line = logLine({ tricky });

    expect(line).not.toContain("unredacted");
    expect(line).toContain("kept-label");
  });

  test("writes only plain data, dropping functions", () => {
    const line = logLine({
      handler: () => "plain-function-output",
      nested: { toJSON: "a string, not a function", kept: 1 },
    });

    expect(line).not.toContain("plain-function-output");
    expect(JSON.parse(line)).toMatchObject({
      nested: { toJSON: "a string, not a function", kept: 1 },
    });
    expect(line).not.toContain('"handler"');
  });

  test("keeps the envelope when the fields object has its own toJSON", () => {
    const fields = { toJSON: () => "replaced everything" };
    const logged = JSON.parse(logLine(fields, "real message")) as Record<
      string,
      unknown
    >;

    expect(logged).toMatchObject({
      level: "info",
      msg: "real message",
      fields: "replaced everything",
    });
    expect(logged["time"]).toBe("2026-11-22T10:00:00.000Z");
  });

  test("masks a throwing getter with a secret name without calling it", () => {
    let called = false;
    const fields = {
      get password(): string {
        called = true;
        throw new Error("plain-getter-secret");
      },
      user: "ada",
    };
    const line = logLine(fields);

    expect(called).toBe(false);
    expect(JSON.parse(line)).toMatchObject({ password: REDACTED, user: "ada" });
  });

  test("marks values that throw when read, converted or redacted", () => {
    const line = logLine({
      getter: Object.defineProperty({}, "value", {
        enumerable: true,
        get() {
          throw new Error("plain-getter-error");
        },
      }),
      json: {
        toJSON() {
          throw new Error("plain-tojson-error");
        },
      },
      self: {
        [redactSelf]() {
          throw new Error("plain-hook-error");
        },
      },
      proxy: new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("plain-proxy-error");
          },
        },
      ),
      kept: "ada",
    });

    expect(line).not.toContain("plain-");
    expect(JSON.parse(line)).toEqual({
      time: "2026-11-22T10:00:00.000Z",
      level: "info",
      msg: "event",
      getter: { value: UNREADABLE },
      json: UNREADABLE,
      self: UNREADABLE,
      proxy: UNREADABLE,
      kept: "ada",
    });
  });

  test("cuts off very deep objects instead of throwing", () => {
    let deep: Record<string, unknown> = { bottom: "plain-bottom" };
    for (let i = 0; i < 10_000; i += 1) deep = { next: deep };
    const line = logLine({ deep, kept: "ada" });

    expect(line).toContain(TOO_DEEP);
    expect(line).not.toContain("plain-bottom");
    expect(line).toContain('"kept":"ada"');
  });
});

describe("large hostile strings", () => {
  const size = 1_000_000;
  const inputs: Record<string, string> = {
    "PEM openings with no end": "-----BEGIN ".repeat(size / 11),
    "PEM private key openings with no end":
      "-----BEGIN PRIVATE KEY-----".repeat(size / 27),
    "sk- repeated": "sk-".repeat(size / 3),
    "sk-proj- with no key": "sk-proj-".repeat(size / 8),
    "JWT starts joined by hyphens": "eyJ-".repeat(size / 4),
    "JWT segments with no third part": "eyJaaaaaaaa.".repeat(size / 12),
    "a long word": "a".repeat(size),
    "Bearer then spaces": `Bearer ${" ".repeat(size)}`,
    "URL starts with no @": "//a:b".repeat(size / 5),
    assignments: "a=".repeat(size / 2),
    "JSON keys with no value": '"k": '.repeat(size / 5),
    "an open JSON value": `"password":"${"x".repeat(size)}`,
    "ghp_ repeated": "ghp_".repeat(size / 4),
    "JWT starts after hyphens": "key-eyJaaaaaaaa".repeat(size / 15),
    "JWT headers with no payload": "eyJaaaaaaaa.".repeat(size / 12) + "x",
    "sk-proj- after hyphens": "-sk-proj-a".repeat(size / 10),
    "query names with no value": "&a".repeat(size / 2),
    "escaped JSON names": '"\\'.repeat(size / 2),
    "AWS prefixes": "AKIA-".repeat(size / 5),
  };

  test.each(Object.entries(inputs))("%s finishes quickly", (_name, input) => {
    const started = performance.now();
    redactText(input);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("token boundaries", () => {
  const families: Record<string, { token: string; secret: string }> = {
    Anthropic: {
      token: "sk-ant-api03-abcdefghijklmnopqrstuv",
      secret: "abcdefghijklmnopqrstuv",
    },
    OpenAI: {
      token: "sk-proj-abcdefghijklmnopqrstuvwx",
      secret: "abcdefghijklmnopqrstuvwx",
    },
    xAI: {
      token: "xai-abcdefghijklmnopqrstuvwxyz",
      secret: "abcdefghijklmnopqrstuvwxyz",
    },
    GitHub: {
      token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      secret: "abcdefghijklmnopqrstuvwxyz0123456789",
    },
    "GitHub fine-grained": {
      token: "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz",
      secret: "11ABCDEFG0abcdefghijklmnopqrstuvwxyz",
    },
    "1Password": {
      token: "ops_eyJzaWduSW5BZGRyZXNzIjoibXkuMXBhc3N3b3JkLmNvbSJ9",
      secret: "eyJzaWduSW5BZGRyZXNzIjoibXkuMXBhc3N3b3JkLmNvbSJ9",
    },
    Slack: {
      token: "xoxb-1234567890-abcdefghij",
      secret: "1234567890-abcdefghij",
    },
    AWS: { token: "AKIAIOSFODNN7EXAMPLE", secret: "IOSFODNN7EXAMPLE" },
    age: {
      token: `AGE-SECRET-KEY-1${"Q".repeat(58)}`,
      secret: "Q".repeat(58),
    },
    JWT: { token: jwt, secret: "c2lnbmF0dXJlc2lnbmF0dXJl" },
  };
  const contexts: Record<string, (token: string) => string> = {
    "after a hyphen": (t) => `key-${t}`,
    "after a dot": (t) => `key.${t}`,
    "after a slash": (t) => `path/${t}`,
    "after an equals sign": (t) => `value=${t}`,
    "after a colon": (t) => `key:${t}`,
    "in double quotes": (t) => `"${t}"`,
    "in single quotes": (t) => `'${t}'`,
    "in brackets": (t) => `[${t}] (${t}) {${t}}`,
    "between spaces": (t) => `use ${t} now`,
    "before a hyphen": (t) => `${t}-suffix`,
    "before a dot": (t) => `${t}.`,
    "before a slash or colon": (t) => `${t}/x ${t}:x`,
    "in a URL path": (t) => `https://example.com/hooks/${t}/run`,
    "in a URL query": (t) => `https://example.com/cb?q=${t}&page=2`,
    "in a name=value pair": (t) => `note=${t} other=1`,
  };
  const cases = Object.entries(families).flatMap(
    ([family, { token, secret }]) =>
      Object.entries(contexts).map(
        ([context, wrap]) => [family, context, wrap(token), secret] as const,
      ),
  );

  test.each(cases)(
    "%s token %s is masked",
    (_family, _context, text, secret) => {
      const redacted = redactText(text);
      expect(redacted).not.toContain(secret);
      expect(redacted).toContain(REDACTED);
    },
  );

  test.each(Object.entries(families))(
    "%s token joined to a letter in front is kept",
    (_family, { token }) => {
      expect(redactText(`x${token}`)).toBe(`x${token}`);
    },
  );
});

describe("text rules", () => {
  test("masks a secret query value up to the next & even with commas", () => {
    const redacted = redactText(
      "https://example.com/cb?token=plain-a,plain-b;plain-c&page=2",
    );

    expect(redacted).toBe("https://example.com/cb?token=[REDACTED]&page=2");
  });

  test("decodes escapes in a JSON field name before matching it", () => {
    const redacted = redactText(
      '{"pass\\u0077ord":"plain-escaped","us\\u0065r":"ada"}',
    );

    expect(redacted).not.toContain("plain-escaped");
    expect(redacted).toContain('"us\\u0065r":"ada"');
  });
});

describe("more hostile values", () => {
  test("reads an enumerable toJSON accessor once", () => {
    let reads = 0;
    const value = Object.defineProperty({ kept: "ada" }, "toJSON", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? "plain-first-read" : "plain-second-read";
      },
    });
    const line = logLine({ value });

    expect(reads).toBe(1);
    expect(line).not.toContain("plain-second-read");
    expect(JSON.parse(line)).toMatchObject({
      value: { kept: "ada", toJSON: "plain-first-read" },
    });
  });

  test("writes a byte count only when byteLength is a number", () => {
    const forged = Object.defineProperty(new Uint8Array(4), "byteLength", {
      get: () => "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    });
    const line = logLine({ forged, real: new Uint8Array(3) });

    expect(line).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(JSON.parse(line)).toMatchObject({
      forged: "[bytes]",
      real: "[3 bytes]",
    });
  });
});
