import { isAbsolute } from "node:path";
import { Argument, Flag } from "effect/cli";
import { z } from "zod";
import { defaultConfigDir } from "../config";

export const defaultStateDir = "/var/lib/aphelion";
export const defaultPluginsDir = "/opt/aphelion/plugins";
export const defaultToolsDir = "/opt/aphelion/tools";

export const options = {
  headless: "headless",
  configDir: "config-dir",
  stateDir: "state-dir",
  pluginsDir: "plugins-dir",
  toolsDir: "tools-dir",
  compose: "compose",
  days: "days",
  approve: "approve",
  pluginRunnerFds: "plugin-runner-fds",
  pluginDev: "plugin-dev",
} as const;

export const operands = {
  "config check": undefined,
  "device add": "name",
  "device list": undefined,
  "device revoke": "id",
  "plugin install": "folder",
  "plugin update": "plugin id",
  "plugin rollback": "plugin id",
  "plugin restart": "plugin id",
  "plugin dev": "folder",
  "tool list": undefined,
  "tool install": "tool name",
  "tool remove": "tool name",
} as const;

export const ownText = "usage:";

const nonEmpty = z.string().min(1, { error: "can't be empty" });

export const absolutePath = z
  .string()
  .refine(isAbsolute, { error: "must be an absolute path" });

const check = <T>(schema: z.ZodType<T, string>, text: string): T => {
  const parsed = nonEmpty.pipe(schema).safeParse(text);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "is not valid");
  }
  return parsed.data;
};

const complaint = (label: string) => (error: unknown) =>
  `${ownText}${label}${error instanceof Error ? error.message : "is not valid"}`;

export const checkedFlag = <T>(name: string, schema: z.ZodType<T, string>) =>
  Flag.String(name).pipe(
    Flag.mapTryCatch((text) => check(schema, text), complaint("")),
  );

export const textFlag = (name: string) => checkedFlag(name, z.string());

export const checkedArgument = <T>(
  name: string,
  label: string,
  schema: z.ZodType<T, string>,
) =>
  Argument.String(name).pipe(
    Argument.mapTryCatch((text) => check(schema, text), complaint(`${label} `)),
  );

export const stateDir = textFlag(options.stateDir).pipe(
  Flag.withDefault(defaultStateDir),
  Flag.withDescription(
    `Folder for the database and sockets (default ${defaultStateDir})`,
  ),
);

export const configDir = textFlag(options.configDir).pipe(
  Flag.withDefault(defaultConfigDir),
  Flag.withDescription(
    `Folder of the config files (default ${defaultConfigDir})`,
  ),
);

export const pluginsDir = checkedFlag(options.pluginsDir, absolutePath).pipe(
  Flag.withDefault(defaultPluginsDir),
  Flag.withDescription(
    `Folder of installed plugins (default ${defaultPluginsDir})`,
  ),
);

export const toolsDir = checkedFlag(options.toolsDir, absolutePath).pipe(
  Flag.withDefault(defaultToolsDir),
  Flag.withDescription(
    `Folder of installed AI tools (default ${defaultToolsDir})`,
  ),
);
