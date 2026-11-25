import { z } from "zod";

export const toolNames = ["claude", "codex", "grok", "opencode"] as const;
export const processors = ["x86_64", "aarch64"] as const;
export const checksumSources = [
  "vendor-manifest",
  "github-digest",
  "sha256sums",
  "recorded",
] as const;

export const maxBuildBytes = 1024 ** 3;

export const toolName = z
  .enum(toolNames, { error: "must be claude, codex, grok or opencode" })
  .brand<"ToolName">();
export type ToolName = z.infer<typeof toolName>;
export type Processor = (typeof processors)[number];

export const sha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { error: "must be 64 lowercase hex digits" })
  .brand<"Sha256">();
export type Sha256 = z.infer<typeof sha256>;

const isDownloadUrl = (text: string) => {
  try {
    const url = new URL(text);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
};

const downloadUrl = z.string().refine(isDownloadUrl, {
  error: "must be an http or https address with no user name or password",
});

const entryPath = z
  .string()
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, {
    error: "must be a relative path of plain names",
  })
  .refine(
    (path) => path.split("/").every((part) => part !== "." && part !== ".."),
    {
      error: "must not hold . or .. parts",
    },
  );

const build = z
  .strictObject({
    url: downloadUrl,
    sha256,
    size: z.number().int().positive().max(maxBuildBytes),
    format: z.enum(["binary", "tar.gz"]),
    entry: entryPath,
  })
  .refine((one) => one.format === "tar.gz" || !one.entry.includes("/"), {
    error: "a binary's entry must be a file name, not a path",
    path: ["entry"],
  });
export type Build = z.infer<typeof build>;

const argv = z.array(z.string().min(1)).nonempty();

const tool = z
  .strictObject({
    name: toolName,
    version: z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/, {
      error: "must be three numbers, such as 2.1.330",
    }),
    builds: z.strictObject({
      x86_64: build.optional(),
      aarch64: build.optional(),
    }),
    signIn: argv,
    status: argv.optional(),
    checksumSource: z.enum(checksumSources),
  })
  .refine(({ name, signIn }) => signIn[0] === name, {
    error: "must start with the tool's name",
    path: ["signIn"],
  })
  .refine(({ name, status }) => status === undefined || status[0] === name, {
    error: "must start with the tool's name",
    path: ["status"],
  });
export type Tool = z.infer<typeof tool>;

const toolList = z
  .strictObject({ version: z.literal(1), tools: z.array(tool) })
  .refine(
    ({ tools }) => new Set(tools.map(({ name }) => name)).size === tools.length,
    { error: "a tool name is listed twice", path: ["tools"] },
  );
export type ToolList = z.infer<typeof toolList>;

export type ParsedToolList =
  | { readonly ok: true; readonly list: ToolList }
  | { readonly ok: false; readonly message: string };

export function parseToolList(text: string): ParsedToolList {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, message: "the tool list isn't valid JSON" };
  }
  const parsed = toolList.safeParse(json);
  if (parsed.success) return { ok: true, list: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path.join(".") ?? "";
  return {
    ok: false,
    message: `the tool list is invalid${where === "" ? "" : ` at ${where}`}: ${issue?.message ?? "unknown problem"}`,
  };
}

export type Availability =
  | { readonly kind: "available"; readonly tool: Tool; readonly build: Build }
  | { readonly kind: "unavailable"; readonly tool: Tool };

export function buildFor(tool: Tool, processor: Processor): Availability {
  const found = tool.builds[processor];
  return found === undefined
    ? { kind: "unavailable", tool }
    : { kind: "available", tool, build: found };
}

export function processorFor(nodeArch: string): Processor | undefined {
  switch (nodeArch) {
    case "x64":
      return "x86_64";
    case "arm64":
      return "aarch64";
    default:
      return undefined;
  }
}
