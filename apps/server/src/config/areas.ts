import { z } from "zod";

export type Migration = (
  document: Record<string, unknown>,
) => Record<string, unknown>;

export function defineArea<Fields extends z.ZodRawShape>(definition: {
  file: string;
  description: string;
  migrations: readonly Migration[];
  fields: Fields;
}) {
  const version = definition.migrations.length + 1;
  return {
    file: definition.file,
    version,
    migrations: definition.migrations,
    schema: z
      .strictObject({
        version: z
          .literal(version)
          .describe("The file's format version. Aphelion migrates older ones."),
        ...definition.fields,
      })
      .meta({ title: definition.file, description: definition.description }),
  };
}

export type Area = ReturnType<typeof defineArea>;

const id = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, {
  error:
    "must be 1 to 63 lowercase letters, digits or hyphens, starting with a letter",
});

const bot = z.strictObject({
  name: id.describe(
    "Unique bot name. Also the name of the bot's folder (decision 0010).",
  ),
  provider: id.describe("The bot CLI that runs the bot."),
  model: z
    .string()
    .min(1, { error: "must not be empty" })
    .describe("The model the provider runs."),
  connectors: z
    .array(id)
    .describe("Ids of the connectors the bot may use. Can be empty."),
  policyProfile: id.describe("The approval profile the bot's actions pass."),
  folder: z
    .string()
    .regex(/^\//, { error: "must be an absolute path" })
    .describe(
      "Absolute path of the bot's folder. Normally the bot's name under /var/lib/aphelion-bots.",
    ),
});

const bots = z.array(bot).superRefine((list, context) => {
  const seen = new Map<string, number>();
  list.forEach(({ name }, index) => {
    const first = seen.get(name);
    if (first === undefined) {
      seen.set(name, index);
      return;
    }
    context.addIssue({
      code: "custom",
      path: [index, "name"],
      message: `duplicates bots[${String(first)}].name "${name}"`,
    });
  });
});

const ipAddress = z
  .string()
  .refine(
    (value) =>
      z.ipv4().safeParse(value).success || z.ipv6().safeParse(value).success,
    { error: "must be an IPv4 or IPv6 address, such as 0.0.0.0" },
  );

export const configAreas = {
  bots: defineArea({
    file: "bots.yaml",
    description:
      "What each bot is allowed to do. Instructions live in the bot's folder, not here (decision 0010).",
    migrations: [],
    fields: {
      bots: bots.describe("One entry per bot. Names must be unique."),
    },
  }),
  policy: defineArea({
    file: "policy.yaml",
    description:
      "Approval rules. The file has no fields yet. Issue M2-01 adds the policy model.",
    migrations: [],
    fields: {},
  }),
  routines: defineArea({
    file: "routines.yaml",
    description:
      "Scheduled and on-demand routines. The file has no fields yet. Issue M6-02 adds routine definitions.",
    migrations: [],
    fields: {},
  }),
  connectors: defineArea({
    file: "connectors.yaml",
    description:
      "Connector settings. The file has no fields yet. Milestone M3 adds connector entries.",
    migrations: [],
    fields: {},
  }),
  server: defineArea({
    file: "server.yaml",
    description:
      "Where the server listens for HTTP and WebSocket connections (decisions 0016 and 0022).",
    migrations: [],
    fields: {
      address: ipAddress.describe(
        "The address the server listens on. In the container it must be 0.0.0.0, the container's own interface, and `aphelion config check --compose` refuses any other. The Compose file decides which host address the port is published on.",
      ),
      port: z
        .int({ error: "must be a whole number" })
        .min(1, { error: "must be from 1 to 65535" })
        .max(65535, { error: "must be from 1 to 65535" })
        .describe(
          "The TCP port the server listens on. In the container it must be 7400, the only port the host firewall lets in, and `aphelion config check --compose` refuses any other.",
        ),
    },
  }),
};

export type ConfigAreas = typeof configAreas;

export type Config = {
  [Name in keyof ConfigAreas]: z.output<ConfigAreas[Name]["schema"]>;
};
