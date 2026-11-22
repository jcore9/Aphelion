export const REDACTED = "[REDACTED]";

export const redactSelf = Symbol.for("aphelion.redactSelf");

export interface SelfRedacting {
  [redactSelf](): unknown;
}

export interface ValuePattern {
  readonly name: string;
  readonly pattern: RegExp;
}

export interface RedactionRules {
  readonly fieldNames: readonly string[];
  readonly valuePatterns: readonly ValuePattern[];
}

export const defaultRules: RedactionRules = {
  fieldNames: [
    "token",
    "password",
    "passwd",
    "passphrase",
    "secret",
    "secrets",
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "api key",
    "apikey",
    "access key",
    "secret key",
    "private key",
  ],
  valuePatterns: [
    {
      name: "Bearer or Basic credentials",
      pattern: /(?<=\b(?:Bearer|Basic)\s+)[\w.~+/=-]{8,}/gi,
    },
    {
      name: "Password in a URL",
      pattern: /(?<=\/\/[^\s/@:]+:)[^\s/@]+(?=@)/g,
    },
    { name: "Anthropic or OpenAI API key", pattern: /\bsk-[\w-]{20,}/g },
    { name: "xAI API key", pattern: /\bxai-[A-Za-z0-9]{20,}/g },
    {
      name: "GitHub token",
      pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,})/g,
    },
    { name: "1Password service account token", pattern: /\bops_[\w-]{20,}/g },
    { name: "Slack token", pattern: /\bxox[abeposr]-[\w-]{10,}/g },
    { name: "AWS access key ID", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
    { name: "age secret key", pattern: /\bAGE-SECRET-KEY-1[0-9A-Z]{58}\b/g },
    {
      name: "JSON Web Token",
      pattern: /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g,
    },
    {
      name: "PEM private key",
      pattern:
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    },
  ],
};

function words(fieldName: string): string[] {
  return fieldName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSelfRedacting(value: object): value is SelfRedacting {
  return typeof (value as Partial<SelfRedacting>)[redactSelf] === "function";
}

function hasToJSON(value: object): value is { toJSON(): unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === "function";
}

function errorFields(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...("cause" in error ? { cause: error.cause } : {}),
    ...(error instanceof AggregateError ? { errors: error.errors } : {}),
    ...Object.fromEntries(Object.entries(error)),
  };
}

export function redact(
  value: unknown,
  rules: RedactionRules = defaultRules,
): unknown {
  const sensitive = rules.fieldNames.map((name) => name.split(" "));
  const ancestors = new WeakSet<object>();

  function isSensitive(fieldName: string): boolean {
    const parts = words(fieldName);
    return sensitive.some(
      (rule) =>
        rule.length <= parts.length &&
        rule.every((word, i) => parts[parts.length - rule.length + i] === word),
    );
  }

  function redactText(text: string): string {
    return rules.valuePatterns.reduce(
      (result, { pattern }) => result.replace(pattern, REDACTED),
      text,
    );
  }

  function walk(value: unknown): unknown {
    if (typeof value === "string") return redactText(value);
    if (typeof value === "bigint") return value.toString();
    if (typeof value !== "object" || value === null) return value;
    if (ancestors.has(value)) return "[Circular]";
    ancestors.add(value);
    try {
      if (isSelfRedacting(value)) return walk(value[redactSelf]());
      if (ArrayBuffer.isView(value))
        return `[${String(value.byteLength)} bytes]`;
      if (hasToJSON(value)) return walk(value.toJSON());
      if (Array.isArray(value)) return value.map(walk);
      const fields = value instanceof Error ? errorFields(value) : value;
      return Object.fromEntries(
        Object.entries(fields).map(([name, field]) => [
          name,
          isSensitive(name) ? REDACTED : walk(field),
        ]),
      );
    } finally {
      ancestors.delete(value);
    }
  }

  return walk(value);
}
