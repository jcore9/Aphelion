import { parseArgs } from "node:util";
import { z } from "zod";
import { defaultConfigDir } from "../config";
import { deviceId, deviceName, lifetimeDays } from "../devices";

export const defaultStateDir = "/var/lib/aphelion";

const options = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
  headless: { type: "boolean" },
  "config-dir": { type: "string" },
  "state-dir": { type: "string" },
  compose: { type: "string" },
  days: { type: "string" },
} as const;

type Option = keyof typeof options;

export type Command =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | {
      readonly kind: "headless";
      readonly configDir: string;
      readonly stateDir: string;
    }
  | {
      readonly kind: "config check";
      readonly configDir: string;
      readonly stateDir: string;
      readonly compose: string | undefined;
    }
  | {
      readonly kind: "device add";
      readonly stateDir: string;
      readonly name: string;
      readonly days: number | undefined;
    }
  | { readonly kind: "device list"; readonly stateDir: string }
  | {
      readonly kind: "device revoke";
      readonly stateDir: string;
      readonly id: string;
    };

type Kind = Command["kind"];

const grammar: Record<
  Kind,
  {
    readonly words: number;
    readonly operand?: string;
    readonly flags: Option[];
  }
> = {
  help: { words: 0, flags: ["help"] },
  version: { words: 0, flags: ["version"] },
  headless: { words: 0, flags: ["headless", "config-dir", "state-dir"] },
  "config check": {
    words: 2,
    flags: ["config-dir", "state-dir", "compose"],
  },
  "device add": { words: 2, operand: "name", flags: ["state-dir", "days"] },
  "device list": { words: 2, flags: ["state-dir"] },
  "device revoke": { words: 2, operand: "id", flags: ["state-dir"] },
};

export type ParseResult =
  | { readonly ok: true; readonly command: Command }
  | { readonly ok: false; readonly message: string };

const fail = (message: string): ParseResult => ({ ok: false, message });

const days = z
  .string()
  .regex(/^\d+$/, { error: "must be a whole number of days" })
  .transform(Number)
  .pipe(lifetimeDays);

function check<T>(
  label: string,
  schema: z.ZodType<T, string>,
  text: string,
): { ok: true; value: T } | { ok: false; message: string } {
  const parsed = schema.safeParse(text);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    message: `${label} ${parsed.error.issues[0]?.message ?? "is not valid"}`,
  };
}

function kindOf(
  positionals: readonly string[],
  values: Partial<Record<Option, unknown>>,
): Kind | undefined {
  if (values.version === true) return "version";
  if (values.headless === true) return "headless";
  if (positionals.length === 0) return "help";
  const words = `${positionals[0] ?? ""} ${positionals[1] ?? ""}`;
  return Object.keys(grammar).find(
    (kind): kind is Kind => grammar[kind as Kind].words === 2 && kind === words,
  );
}

export function parseCommandLine(argv: readonly string[]): ParseResult {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return fail((error as Error).message);
  }
  const { values, positionals } = parsed;

  if (values.help === true) return { ok: true, command: { kind: "help" } };
  const kind = kindOf(positionals, values);
  if (kind === undefined) {
    return fail(`unknown command "${positionals.slice(0, 2).join(" ")}"`);
  }
  const rule = grammar[kind];

  const extra = (Object.keys(values) as Option[]).find(
    (flag) => !rule.flags.includes(flag),
  );
  if (extra !== undefined) {
    return fail(
      kind === "help"
        ? `--${extra} can't be combined with --help`
        : `--${extra} isn't an option of "${kind}"`,
    );
  }
  const operands = positionals.slice(rule.words);
  const expected = rule.operand === undefined ? 0 : 1;
  if (operands.length !== expected) {
    return fail(
      rule.operand !== undefined && operands.length === 0
        ? `"${kind}" needs a ${rule.operand}`
        : `"${kind}" takes ${rule.operand === undefined ? "no arguments" : `one ${rule.operand}`}, but got: ${operands.join(" ")}`,
    );
  }

  const configDir = values["config-dir"] ?? defaultConfigDir;
  const stateDir = values["state-dir"] ?? defaultStateDir;
  const operand = operands[0] ?? "";
  switch (kind) {
    case "help":
    case "version":
      return { ok: true, command: { kind } };
    case "headless":
      return { ok: true, command: { kind, configDir, stateDir } };
    case "config check":
      return {
        ok: true,
        command: { kind, configDir, stateDir, compose: values.compose },
      };
    case "device add": {
      const name = check("the device name", deviceName, operand);
      if (!name.ok) return name;
      if (values.days === undefined) {
        return {
          ok: true,
          command: { kind, stateDir, name: name.value, days: undefined },
        };
      }
      const lifetime = check("--days", days, values.days);
      if (!lifetime.ok) return lifetime;
      return {
        ok: true,
        command: { kind, stateDir, name: name.value, days: lifetime.value },
      };
    }
    case "device list":
      return { ok: true, command: { kind, stateDir } };
    case "device revoke": {
      const id = check("the device id", deviceId, operand);
      if (!id.ok) return id;
      return { ok: true, command: { kind, stateDir, id: id.value } };
    }
  }
}
