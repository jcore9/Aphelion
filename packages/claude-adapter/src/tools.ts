import {
  permissionRequest,
  type PermissionRequest,
  type ToolKind,
} from "@aphelion/plugin-sdk";
import { fitBytes } from "./text.ts";

const kinds = new Map<string, ToolKind>([
  ["Read", "file.read"],
  ["Glob", "file.read"],
  ["Grep", "file.read"],
  ["Write", "file.write"],
  ["Edit", "file.write"],
  ["NotebookEdit", "file.write"],
  ["Bash", "shell"],
  ["WebFetch", "web"],
  ["WebSearch", "web"],
]);

export const toolKind = (tool: string): ToolKind => kinds.get(tool) ?? "other";

const pathFields = new Map<string, readonly string[]>([
  ["Glob", ["path", "pattern"]],
  ["Grep", ["path", "glob"]],
]);

const maxBytes = 4096;

const pathsOf = (tool: string, input: Readonly<Record<string, unknown>>) => {
  const fields = pathFields.get(tool) ?? ["file_path", "notebook_path", "path"];
  const paths = fields
    .map((field) => input[field])
    .filter((value): value is string => typeof value === "string");
  return pathFields.has(tool) && typeof input["path"] !== "string"
    ? [".", ...paths]
    : paths;
};

export interface ToolAsk {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly call: string;
  readonly request: string;
}

export function permissionRequestFor(
  ask: ToolAsk,
): PermissionRequest | undefined {
  const paths = pathsOf(ask.tool, ask.input).map((path) =>
    fitBytes(path, maxBytes),
  );
  const command =
    toolKind(ask.tool) === "shell" && typeof ask.input["command"] === "string"
      ? fitBytes(ask.input["command"], maxBytes)
      : null;
  const parsed = permissionRequest.safeParse({
    request: ask.request,
    call: ask.call,
    tool: ask.tool,
    kind: toolKind(ask.tool),
    paths: paths.map((path) => path.text),
    command: command?.text ?? null,
    truncated: paths.some((path) => path.cut) || (command?.cut ?? false),
  });
  return parsed.success ? parsed.data : undefined;
}
