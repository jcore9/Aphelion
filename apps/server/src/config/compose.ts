import { LineCounter, parseDocument } from "yaml";
import { z } from "zod";
import type { ConfigIssue } from "./issues";
import { issueAt, schemaIssues } from "./load";

export const composeListener = { address: "0.0.0.0", port: 7400 } as const;

const portEntry = z.union([
  z.string(),
  z.number(),
  z.looseObject({
    host_ip: z.string().optional(),
    target: z.unknown().optional(),
    protocol: z.unknown().optional(),
  }),
]);

type PortEntry = z.output<typeof portEntry>;

const composeFile = z.looseObject(
  {
    include: z.unknown().optional(),
    networks: z
      .record(
        z.string(),
        z
          .looseObject({
            name: z.unknown().optional(),
            driver: z.unknown().optional(),
            external: z.unknown().optional(),
            driver_opts: z.record(z.string(), z.unknown()).optional(),
          })
          .nullable(),
      )
      .optional(),
    services: z
      .record(
        z.string(),
        z.looseObject({
          extends: z.unknown().optional(),
          ports: z.array(portEntry).optional(),
          network_mode: z.string().optional(),
          networks: z.unknown().optional(),
        }),
      )
      .optional(),
  },
  { error: "must be a YAML mapping" },
);

const notResolved =
  "is not resolved. Run the check on the output of `docker compose config`, which fills in variables and merges include, extends and override files.";
const howToFix = `Publish it only on the host's tailnet address, such as "100.71.226.67:${String(composeListener.port)}:${String(composeListener.port)}" (decision 0022).`;
const otherContainer =
  "shares the network of a container outside this file, so the check can't see which ports it publishes.";
const gatewayModes = [
  "com.docker.network.bridge.gateway_mode_ipv4",
  "com.docker.network.bridge.gateway_mode_ipv6",
];
const everyPort = `which publishes every port on every host address. ${howToFix}`;

function hasVariable(value: unknown): boolean {
  if (typeof value === "string") return value.includes("$");
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, item]) => key.includes("$") || hasVariable(item),
  );
}

function isTailnet(address: string): boolean {
  if (!z.ipv4().safeParse(address).success) return false;
  const [first, second] = address.split(".").map(Number);
  return first === 100 && second !== undefined && second >= 64 && second < 128;
}

function hostAddress(entry: PortEntry): string | undefined {
  if (typeof entry === "number") return undefined;
  if (typeof entry === "object") return entry.host_ip;
  const parts = (entry.split("/", 1)[0] ?? "").split(":");
  return parts.length > 2 ? parts.slice(0, -2).join(":") : undefined;
}

function forwarding(entry: PortEntry): { target: unknown; protocol: unknown } {
  if (typeof entry === "number") return { target: entry, protocol: "tcp" };
  if (typeof entry === "object") {
    return { target: entry.target, protocol: entry.protocol ?? "tcp" };
  }
  const [body = "", protocol = "tcp"] = entry.split("/");
  return { target: body.split(":").at(-1), protocol };
}

function forwardIssue(
  entry: PortEntry,
  serverPort: number,
): string | undefined {
  const { target, protocol } = forwarding(entry);
  const port =
    typeof target === "string" && /^\d+$/.test(target)
      ? Number(target)
      : target;
  const tcp = typeof protocol === "string" && protocol.toLowerCase() === "tcp";
  if (port === serverPort && tcp) return undefined;
  const expected = `it must forward to TCP port ${String(serverPort)}, the server's port in server.yaml.`;
  if (
    (typeof target !== "string" && typeof target !== "number") ||
    target === ""
  ) {
    return `has no container port number, but ${expected}`;
  }
  const suffix = tcp
    ? ""
    : `/${typeof protocol === "string" ? protocol : "an unknown protocol"}`;
  return `forwards to container port ${String(target)}${suffix}, but ${expected}`;
}

export function checkServerListener(
  file: string,
  server: { readonly address: string; readonly port: number },
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (server.address !== composeListener.address) {
    issues.push({
      file,
      field: "address",
      message: `is ${server.address}. With --compose it must be ${composeListener.address}, so a published port can reach the server inside the container.`,
    });
  }
  if (server.port !== composeListener.port) {
    issues.push({
      file,
      field: "port",
      message: `is ${String(server.port)}. With --compose it must be ${String(composeListener.port)}, the port the host firewall opens.`,
    });
  }
  return issues;
}

export function checkComposePorts(
  file: string,
  text: string,
  serverPort?: number,
): ConfigIssue[] {
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
  if (document.warnings.length > 0) {
    return document.warnings.map((warning) => ({
      file,
      position: lines.linePos(warning.pos[0]),
      message: `A YAML tag ${notResolved}`,
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
  const { include, networks = {}, services = {} } = parsed.data;
  if (Object.keys(services).length === 0) {
    return [
      at(
        ["services"],
        "has no services, so this isn't the output of `docker compose config` for Aphelion's Compose file.",
      ),
    ];
  }

  const networkIssues = Object.entries(networks).flatMap(([name, network]) => {
    const path = ["networks", name];
    if (hasVariable(name) || hasVariable(network))
      return [at(path, notResolved)];
    if (network === null) return [];
    if (network.name === "host" || network.driver === "host") {
      return [at(path, `is the host's network, ${everyPort}`)];
    }
    if (network.external !== undefined && network.external !== false) {
      return [
        at(
          [...path, "external"],
          "is defined outside this file, so the check can't see its driver or options.",
        ),
      ];
    }
    if (network.driver !== undefined && network.driver !== "bridge") {
      return [
        at(
          [...path, "driver"],
          "is not bridge. The check vouches only for ports published through a bridge network in NAT mode.",
        ),
      ];
    }
    return Object.entries(network.driver_opts ?? {})
      .filter(([key, value]) => gatewayModes.includes(key) && value !== "nat")
      .map(([key, value]) =>
        at(
          [...path, "driver_opts", key],
          `is ${JSON.stringify(value)}, which lets other machines reach the container directly, whatever host address its ports name. Leave it at "nat", the default.`,
        ),
      );
  });

  const serviceIssues = Object.entries(services).flatMap(([name, service]) => {
    const path = ["services", name];
    const unresolved = [
      ...(service.extends === undefined ? [] : ["extends"]),
      ...(["network_mode", "networks"] as const).filter((key) =>
        hasVariable(service[key]),
      ),
    ].map((key) => at([...path, key], notResolved));
    const mode = hasVariable(service.network_mode)
      ? undefined
      : service.network_mode;
    const sharesNetwork =
      mode === "host"
        ? [
            at(
              [...path, "network_mode"],
              `shares the host's network, ${everyPort}`,
            ),
          ]
        : mode?.startsWith("container:")
          ? [at([...path, "network_mode"], otherContainer)]
          : [];
    const ports = (service.ports ?? []).flatMap((entry, index) => {
      const entryPath = [...path, "ports", index];
      if (hasVariable(entry)) return [at(entryPath, notResolved)];
      const address = hostAddress(entry);
      const published =
        address !== undefined && isTailnet(address)
          ? []
          : [
              address === undefined
                ? at(
                    entryPath,
                    `publishes the port on every host address. ${howToFix}`,
                  )
                : at(
                    typeof entry === "object"
                      ? [...entryPath, "host_ip"]
                      : entryPath,
                    `publishes the port on ${address}, which isn't a tailnet address (100.64.0.0/10). ${howToFix}`,
                  ),
            ];
      const forward =
        serverPort === undefined || name !== "aphelion"
          ? undefined
          : forwardIssue(entry, serverPort);
      return [
        ...published,
        ...(forward === undefined ? [] : [at(entryPath, forward)]),
      ];
    });
    return [...unresolved, ...sharesNetwork, ...ports];
  });

  const missingService =
    serverPort !== undefined && services["aphelion"] === undefined
      ? [
          at(
            ["services"],
            "has no service named aphelion, so the check can't see which ports reach the server. Aphelion's Compose file names the server's service aphelion.",
          ),
        ]
      : [];

  return [
    ...(include === undefined ? [] : [at(["include"], notResolved)]),
    ...missingService,
    ...networkIssues,
    ...serviceIssues,
  ];
}
