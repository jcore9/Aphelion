export const REDACTED = "[REDACTED]";
export const UNREADABLE = "[Unreadable]";
export const TOO_DEEP = "[Too deep]";
export const CIRCULAR = "[Circular]";
export const maxDepth = 32;

export const redactSelf = Symbol.for("aphelion.redactSelf");

export interface SelfRedacting {
  [redactSelf](): string;
}

export interface ValueRule {
  readonly name: string;
  readonly replace: (text: string) => string;
}

export interface RedactionRules {
  readonly fieldNameEndings: readonly string[];
  readonly exactFieldNames: readonly string[];
  readonly valueRules: readonly ValueRule[];
}

export function pattern(
  name: string,
  regex: RegExp,
  replacement = REDACTED,
): ValueRule {
  return { name, replace: (text) => text.replace(regex, replacement) };
}

function redactPemPrivateKeys(text: string): string {
  const begin = "-----BEGIN ";
  const quotes = /["'`]/g;
  const footers = new Map<string, number>();
  let quote = -1;
  const quoteAt = (from: number): number => {
    if (quote < from) {
      quotes.lastIndex = from;
      quote = quotes.exec(text)?.index ?? text.length;
    }
    return quote;
  };
  const footerAt = (footer: string, from: number): number => {
    const cached = footers.get(footer);
    if (cached !== undefined && (cached < 0 || cached >= from)) return cached;
    const at = text.indexOf(footer, from);
    footers.set(footer, at);
    return at;
  };
  let result = "";
  let from = 0;
  for (;;) {
    const start = text.indexOf(begin, from);
    if (start < 0) break;
    const labelEnd = text.indexOf("-----", start + begin.length);
    if (labelEnd < 0) break;
    const label = text.slice(start + begin.length, labelEnd);
    if (!/^[A-Z ]*PRIVATE KEY$/.test(label)) {
      result += text.slice(from, labelEnd);
      from = labelEnd;
      continue;
    }
    const footer = `-----END ${label}-----`;
    const end = footerAt(footer, labelEnd);
    const stop = quoteAt(labelEnd);
    result += text.slice(from, start) + REDACTED;
    from = end >= 0 && end < stop ? end + footer.length : stop;
  }
  return result + text.slice(from);
}

function jwtHeaderStart(segment: string): number {
  for (
    let at = segment.indexOf("eyJ");
    at >= 0;
    at = segment.indexOf("eyJ", at + 1)
  ) {
    if (at > 0 && /[A-Za-z0-9_]/.test(segment.charAt(at - 1))) continue;
    return segment.length - at >= 11 ? at : -1;
  }
  return -1;
}

function redactJwtsInRun(run: string): string {
  const segments = run.split(".");
  const kept: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const header = segments[i] ?? "";
    const payload = segments[i + 1] ?? "";
    const signature = segments[i + 2];
    const start = jwtHeaderStart(header);
    if (
      start >= 0 &&
      payload.startsWith("eyJ") &&
      payload.length >= 11 &&
      signature !== undefined &&
      signature.length >= 8
    ) {
      kept.push(header.slice(0, start) + REDACTED);
      i += 2;
    } else {
      kept.push(header);
    }
  }
  return kept.join(".");
}

function redactJsonWebTokens(text: string): string {
  return text.replace(/[\w.-]+/g, (run) =>
    run.includes("eyJ") ? redactJwtsInRun(run) : run,
  );
}

export const defaultRules: RedactionRules = {
  fieldNameEndings: [
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
    "apikey",
    "accesskey",
    "secretkey",
    "privatekey",
  ],
  exactFieldNames: ["pass", "pwd"],
  valueRules: [
    pattern(
      "Bearer or Basic credentials",
      /\b(Bearer|Basic)(\s+)[\w.~+/=-]{8,}/gi,
      `$1$2${REDACTED}`,
    ),
    pattern(
      "Password in a URL",
      /(\/\/[^\s/@:"'`]+:)[^\s/@"'`]+@/g,
      `$1${REDACTED}@`,
    ),
    pattern(
      "Anthropic API key",
      /(?<![A-Za-z0-9_])sk-ant-[a-z]{1,16}\d{0,4}-[\w-]{20,}/g,
    ),
    pattern(
      "OpenAI API key",
      /(?<![A-Za-z0-9_])sk-(?:(?:proj|svcacct|admin)-[\w-]{20,}|[A-Za-z0-9]{32,})/g,
    ),
    pattern("xAI API key", /(?<![A-Za-z0-9_])xai-[A-Za-z0-9]{20,}/g),
    pattern(
      "GitHub token",
      /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,})/g,
    ),
    pattern(
      "1Password service account token",
      /(?<![A-Za-z0-9_])ops_[\w-]{20,}/g,
    ),
    pattern("Slack token", /(?<![A-Za-z0-9_])xox[abeposr]-[\w-]{10,}/g),
    pattern(
      "AWS access key ID",
      /(?<![A-Za-z0-9_])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9_])/g,
    ),
    pattern("age secret key", /(?<![A-Za-z0-9_])AGE-SECRET-KEY-1[0-9A-Z]{58}/g),
    { name: "JSON Web Token", replace: redactJsonWebTokens },
    { name: "PEM private key", replace: redactPemPrivateKeys },
  ],
};

export function isSensitiveName(
  name: string,
  rules: RedactionRules = defaultRules,
): boolean {
  const joined = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    rules.exactFieldNames.includes(joined) ||
    rules.fieldNameEndings.some((ending) => joined.endsWith(ending))
  );
}

export const jsonParseLimit = 64 * 1024;

function decodedJsonName(name: string): string {
  try {
    return String(JSON.parse(`"${name}"`));
  } catch {
    return name;
  }
}

function redactUnstructuredText(text: string, rules: RedactionRules): string {
  const named = text
    .replace(
      /([?&])([\w.-]+)=([^&\s"'`]*)/g,
      (match, separator: string, name: string) =>
        isSensitiveName(name, rules)
          ? `${separator}${name}=${REDACTED}`
          : match,
    )
    .replace(/(?<![\w.-])([\w.-]+)=([^\s&#"'`,;]+)/g, (match, name: string) =>
      isSensitiveName(name, rules) ? `${name}=${REDACTED}` : match,
    )
    .replace(
      /"((?:[^"\\]|\\[^"]){1,1024})"(\s*:\s*)"[^"\\]*(?:\\.[^"\\]*)*"/g,
      (match, name: string, colon: string) =>
        isSensitiveName(decodedJsonName(name), rules)
          ? `"${name}"${colon}"${REDACTED}"`
          : match,
    );
  return rules.valueRules.reduce((result, rule) => rule.replace(result), named);
}

function redactEmbeddedJson(
  text: string,
  open: string,
  close: string,
  rules: RedactionRules,
): string | undefined {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start < 0 || end <= start || end - start >= jsonParseLimit) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  return (
    redactUnstructuredText(text.slice(0, start), rules) +
    JSON.stringify(redact(parsed, rules)) +
    redactUnstructuredText(text.slice(end + 1), rules)
  );
}

export function redactText(
  text: string,
  rules: RedactionRules = defaultRules,
): string {
  return (
    redactEmbeddedJson(text, "{", "}", rules) ??
    redactEmbeddedJson(text, "[", "]", rules) ??
    redactUnstructuredText(text, rules)
  );
}

function errorKeys(error: Error): string[] {
  return [
    ...new Set([
      "name",
      "message",
      "stack",
      ...("cause" in error ? ["cause"] : []),
      ...(error instanceof AggregateError ? ["errors"] : []),
      ...Object.keys(error),
    ]),
  ];
}

export function redact(
  value: unknown,
  rules: RedactionRules = defaultRules,
): unknown {
  const ancestors = new WeakSet<object>();

  function field(source: object, key: string | number, depth: number): unknown {
    try {
      return walk((source as Record<string | number, unknown>)[key], depth);
    } catch {
      return UNREADABLE;
    }
  }

  function walkObject(value: object, depth: number): unknown {
    const hook = (value as { [redactSelf]?: unknown })[redactSelf];
    if (typeof hook === "function") return walk(hook.call(value), depth);
    if (ArrayBuffer.isView(value)) {
      const length: unknown = value.byteLength;
      return typeof length === "number" && Number.isSafeInteger(length)
        ? `[${String(length)} bytes]`
        : "[bytes]";
    }
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") return walk(toJSON.call(value), depth);
    if (Array.isArray(value)) {
      return Array.from({ length: value.length }, (_, index) =>
        field(value, index, depth),
      );
    }
    const keys = value instanceof Error ? errorKeys(value) : Object.keys(value);
    const entries: [string, unknown][] = [];
    for (const key of keys) {
      const result = isSensitiveName(key, rules)
        ? REDACTED
        : key === "toJSON"
          ? walk(toJSON, depth)
          : field(value, key, depth);
      if (result !== undefined) entries.push([key, result]);
    }
    return Object.fromEntries(entries);
  }

  function walk(value: unknown, depth: number): unknown {
    switch (typeof value) {
      case "string":
        return redactText(value, rules);
      case "bigint":
        return value.toString();
      case "number":
      case "boolean":
        return value;
      case "object":
        break;
      default:
        return undefined;
    }
    if (value === null) return null;
    if (depth >= maxDepth) return TOO_DEEP;
    if (ancestors.has(value)) return CIRCULAR;
    ancestors.add(value);
    try {
      return walkObject(value, depth + 1);
    } catch {
      return UNREADABLE;
    } finally {
      ancestors.delete(value);
    }
  }

  return walk(value, 0);
}
