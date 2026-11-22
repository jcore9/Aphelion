import { LineCounter, parseDocument } from "yaml";
import { z } from "zod";
import type { ConfigIssue } from "./issues";
import { issueAt, schemaIssues } from "./load";

const portEntry = z.union([
  z.string(),
  z.number(),
  z.looseObject({ host_ip: z.string().optional() }),
]);

const composeFile = z.looseObject(
  {
    services: z
      .record(
        z.string(),
        z.looseObject({
          ports: z.array(portEntry).optional(),
          network_mode: z.string().optional(),
        }),
      )
      .optional(),
  },
  { error: "must be a YAML mapping" },
);

const howToFix =
  'Publish it only on the host\'s tailnet address, such as "100.71.226.67:7400:7400" (decision 0022).';

function isTailnet(address: string): boolean {
  if (!z.ipv4().safeParse(address).success) return false;
  const [first, second] = address.split(".").map(Number);
  return first === 100 && second !== undefined && second >= 64 && second < 128;
}

function hostAddress(entry: z.output<typeof portEntry>): string | undefined {
  if (typeof entry === "number") return undefined;
  if (typeof entry === "object") return entry.host_ip;
  const parts = (entry.split("/", 1)[0] ?? "").split(":");
  return parts.length > 2 ? parts.slice(0, -2).join(":") : undefined;
}

export function checkComposePorts(file: string, text: string): ConfigIssue[] {
  const lines = new LineCounter();
  const document = parseDocument(text, {
    lineCounter: lines,
    prettyErrors: false,
    merge: true,
  });
  if (document.errors.length > 0) {
    return document.errors.map((error) => ({
      file,
      position: lines.linePos(error.pos[0]),
      message: error.message,
    }));
  }

  let data: unknown;
  try {
    data = document.toJS();
  } catch (error) {
    return [{ file, message: (error as Error).message }];
  }
  const parsed = composeFile.safeParse(data);
  if (!parsed.success) {
    return schemaIssues(file, document, lines, data, parsed.error);
  }

  const at = (path: PropertyKey[], message: string) =>
    issueAt(file, document, lines, path, message);
  return Object.entries(parsed.data.services ?? {}).flatMap(
    ([name, service]) => [
      ...(service.network_mode === "host"
        ? [
            at(
              ["services", name, "network_mode"],
              `shares the host's network, which publishes every port on every host address. ${howToFix}`,
            ),
          ]
        : []),
      ...(service.ports ?? []).flatMap((entry, index) => {
        const address = hostAddress(entry);
        if (address !== undefined && isTailnet(address)) return [];
        const path = ["services", name, "ports", index];
        return [
          address === undefined
            ? at(path, `publishes the port on every host address. ${howToFix}`)
            : at(
                typeof entry === "object" ? [...path, "host_ip"] : path,
                `publishes the port on ${address}, which isn't a tailnet address (100.64.0.0/10). ${howToFix}`,
              ),
        ];
      }),
    ],
  );
}
