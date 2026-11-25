import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { defaultConfigDir } from "../config";
import { deviceId, deviceName, lifetimeDays } from "../devices";

export const defaultStateDir = "/var/lib/aphelion";
export const defaultPluginsDir = "/opt/aphelion/plugins";

const options = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
  headless: { type: "boolean" },
  "config-dir": { type: "string" },
  "state-dir": { type: "string" },
  "plugins-dir": { type: "string" },
  compose: { type: "string" },
  days: { type: "string" },
  approve: { type: "string" },
  "plugin-runner-fds": { type: "string" },
  "plugin-dev": { type: "string" },
} as const;

type Option = keyof typeof options;

export type Command =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | {
      readonly kind: "headless";
      readonly configDir: string;
      readonly stateDir: string;
      readonly pluginRunnerFds: PluginRunnerFds | undefined;
      readonly pluginDev: string | undefined;
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
  | {
      readonly kind: "plugin install";
      readonly stateDir: string;
      readonly pluginsDir: string;
      readonly folder: string;
      readonly approve: string | undefined;
    }
  | {
      readonly kind: "plugin update";
      readonly stateDir: string;
      readonly pluginsDir: string;
      readonly plugin: string;
      readonly approve: string | undefined;
    }
  | {
      readonly kind: "plugin rollback";
      readonly stateDir: string;
      readonly pluginsDir: string;
      readonly plugin: string;
    }
  | {
      readonly kind: "plugin restart";
      readonly stateDir: string;
      readonly plugin: string;
    }
  | {
      readonly kind: "plugin dev";
      readonly stateDir: string;
      readonly folder: string;
    }
  | { readonly kind: "restore finish"; readonly stateDir: string }
  | { readonly kind: "device list"; readonly stateDir: string }
  | {
      readonly kind: "device revoke";
      readonly stateDir: string;
      readonly id: string;
    };

export interface PluginRunnerFds {
  readonly replies: number;
  readonly requests: number;
}

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
  headless: {
    words: 0,
    flags: [
      "headless",
      "config-dir",
      "state-dir",
      "plugin-runner-fds",
      "plugin-dev",
    ],
  },
  "config check": {
    words: 2,
    flags: ["config-dir", "state-dir", "compose"],
  },
  "device add": { words: 2, operand: "name", flags: ["state-dir", "days"] },
  "plugin install": {
    words: 2,
    operand: "folder",
    flags: ["state-dir", "plugins-dir", "approve"],
  },
  "plugin update": {
    words: 2,
    operand: "plugin id",
    flags: ["state-dir", "plugins-dir", "approve"],
  },
  "plugin rollback": {
    words: 2,
    operand: "plugin id",
    flags: ["state-dir", "plugins-dir"],
  },
  "plugin restart": { words: 2, operand: "plugin id", flags: ["state-dir"] },
  "plugin dev": { words: 2, operand: "folder", flags: ["state-dir"] },
  "restore finish": { words: 2, flags: ["state-dir"] },
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

const pluginRunnerFds = z
  .string()
  .regex(/^\d{1,4},\d{1,4}$/, {
    error: "must be two file descriptor numbers, such as 3,4",
  })
  .transform((text) => {
    const [replies = 0, requests = 0] = text.split(",").map(Number);
    return { replies, requests };
  })
  .refine(({ replies, requests }) => replies >= 3 && requests >= 3, {
    error:
      "must name descriptors from 3 up, after standard input, output and error",
  })
  .refine(({ replies, requests }) => replies !== requests, {
    error: "must name two different descriptors",
  });

const absolutePath = z
  .string()
  .refine(isAbsolute, { error: "must be an absolute path" });

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

const plainOption = /^--?[a-z-]+$/;

function parserMessage(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  const option = /'(-[^'\s]*)/.exec((error as Error).message)?.[1];
  const named = option !== undefined && plainOption.test(option);
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    return named ? `unknown option ${option}` : "unknown option";
  }
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    return named ? `${option} needs a value` : "an option needs a value";
  }
  return "the command line can't be read";
}

export function parseCommandLine(argv: readonly string[]): ParseResult {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { ok: true, command: { kind: "help" } };
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options,
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
  } catch (error) {
    return fail(parserMessage(error));
  }
  const { values, positionals, tokens } = parsed;

  if (values.help === true) return { ok: true, command: { kind: "help" } };
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) return fail(`--${token.name} is given twice`);
    seen.add(token.name);
    if (token.value === "") return fail(`--${token.name} can't be empty`);
  }
  const kind = kindOf(positionals, values);
  if (kind === undefined) {
    const words = positionals.slice(0, 2).join(" ");
    return fail(
      /^[a-z -]+$/.test(words)
        ? `unknown command "${words}"`
        : "unknown command",
    );
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
        : `"${kind}" takes ${rule.operand === undefined ? "no arguments" : `one ${rule.operand}`}, but got ${String(operands.length)}`,
    );
  }

  const configDir = values["config-dir"] ?? defaultConfigDir;
  const stateDir = values["state-dir"] ?? defaultStateDir;
  const operand = operands[0] ?? "";
  const pluginsDir = check(
    "--plugins-dir",
    absolutePath,
    values["plugins-dir"] ?? defaultPluginsDir,
  );
  switch (kind) {
    case "help":
    case "version":
      return { ok: true, command: { kind } };
    case "headless": {
      const fdsText = values["plugin-runner-fds"];
      const fds =
        fdsText === undefined
          ? ({ ok: true, value: undefined } as const)
          : check("--plugin-runner-fds", pluginRunnerFds, fdsText);
      if (!fds.ok) return fds;
      const devText = values["plugin-dev"];
      const dev =
        devText === undefined
          ? ({ ok: true, value: undefined } as const)
          : check("--plugin-dev", absolutePath, devText);
      if (!dev.ok) return dev;
      return {
        ok: true,
        command: {
          kind,
          configDir,
          stateDir,
          pluginRunnerFds: fds.value,
          pluginDev: dev.value,
        },
      };
    }
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
    case "plugin install":
      if (!pluginsDir.ok) return pluginsDir;
      return {
        ok: true,
        command: {
          kind,
          stateDir,
          pluginsDir: pluginsDir.value,
          folder: operand,
          approve: values.approve,
        },
      };
    case "plugin update":
    case "plugin rollback": {
      if (!pluginsDir.ok) return pluginsDir;
      const base = { stateDir, pluginsDir: pluginsDir.value, plugin: operand };
      return {
        ok: true,
        command:
          kind === "plugin update"
            ? { kind, ...base, approve: values.approve }
            : { kind, ...base },
      };
    }
    case "plugin restart":
      return { ok: true, command: { kind, stateDir, plugin: operand } };
    case "plugin dev":
      return { ok: true, command: { kind, stateDir, folder: operand } };
    case "restore finish":
    case "device list":
      return { ok: true, command: { kind, stateDir } };
    case "device revoke": {
      const id = check("the device id", deviceId, operand);
      if (!id.ok) return id;
      return { ok: true, command: { kind, stateDir, id: id.value } };
    }
  }
}
