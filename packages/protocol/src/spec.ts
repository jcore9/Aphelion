import { z } from "zod";
import { clientFrame, errorCodes, serverFrame, version } from "./frames.ts";
import { commands, events } from "./registry.ts";

type JsonSchema = {
  $ref?: string;
  type?: string;
  const?: unknown;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: unknown;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  definitions?: Record<string, JsonSchema>;
};

const github = "https://github.com/jcore9/Aphelion/blob/dev/packages/protocol";
const envelopeKeys = ["v", "type"];

function jsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, {
    target: "draft-7",
    io: "input",
  }) as JsonSchema;
}

const frames = {
  "client-frame.schema.json": clientFrame.meta({ title: "ClientFrame" }),
  "server-frame.schema.json": serverFrame.meta({ title: "ServerFrame" }),
};

export function schemaFiles(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(frames).map(([file, schema]) => [
      file,
      `${JSON.stringify(jsonSchema(schema), null, 2)}\n`,
    ]),
  );
}

const code = (value: unknown) => `\`${JSON.stringify(value)}\``;

function integer(schema: JsonSchema): string {
  const min =
    schema.exclusiveMinimum === undefined
      ? schema.minimum
      : schema.exclusiveMinimum + 1;
  const bounds = [
    min === undefined ? "" : `at least ${String(min)}`,
    schema.maximum === undefined || schema.maximum === Number.MAX_SAFE_INTEGER
      ? ""
      : `at most ${String(schema.maximum)}`,
  ].filter(Boolean);
  return ["integer", ...bounds].join(", ");
}

function typeOf(schema: JsonSchema): string {
  if (schema.$ref) {
    const name = schema.$ref.split("/").at(-1) ?? "";
    return `[\`${name}\`](#${name.toLowerCase()})`;
  }
  const union = schema.oneOf ?? schema.anyOf;
  if (union) return union.map(typeOf).join(" or ");
  if (schema.allOf) return schema.allOf.map(typeOf).join(" and ");
  if (schema.const !== undefined) return code(schema.const);
  if (schema.enum) return schema.enum.map(code).join(" or ");
  if (schema.type === "integer") return integer(schema);
  if (schema.type === "array") {
    return `list of ${schema.items ? typeOf(schema.items) : "any"}`;
  }
  if (schema.type === "null") return "`null`";
  if (schema.type === "string" && schema.pattern) {
    return `string matching \`${schema.pattern}\``;
  }
  return schema.type ?? "any";
}

const paragraph = (text?: string) => (text ? [text, ""] : []);

const cell = (text: string) => text.replaceAll("|", "\\|");

function rows(
  objects: JsonSchema[],
  keys: string[],
  prefix?: string,
): string[] {
  return keys.flatMap((key) => {
    const fields = objects.flatMap((object) => object.properties?.[key] ?? []);
    const [field] = fields;
    if (!field) return [];
    const type = [...new Set(fields.map(typeOf))].join(" or ");
    const required = objects[0]?.required?.includes(key) ? "yes" : "no";
    const name = `${prefix ?? ""}${key}`;
    const row = `| \`${name}\` | ${cell(type)} | ${required} | ${cell(field.description ?? "")} |`;
    const nested =
      prefix !== undefined && field.type === "object"
        ? rows([field], Object.keys(field.properties ?? {}), `${name}.`)
        : [];
    return [row, ...nested];
  });
}

function table(lines: string[]): string[] {
  return [
    "| Field | Type | Required | Description |",
    "| --- | --- | --- | --- |",
    ...lines,
  ];
}

function framesOf(union: JsonSchema): JsonSchema[][] {
  return (union.oneOf ?? []).map((frame) => frame.oneOf ?? [frame]);
}

function frameSection(objects: JsonSchema[]): string[] {
  const [first] = objects;
  const keys = Object.keys(first?.properties ?? {}).filter(
    (key) => !envelopeKeys.includes(key),
  );
  return [
    `### \`${String(first?.properties?.["type"]?.const)}\` frame`,
    "",
    ...paragraph(first?.description),
    ...table(rows(objects, keys)),
  ];
}

function value(field: string, schema: JsonSchema): string[] {
  const keys = Object.keys(schema.properties ?? {});
  if (!keys.length) {
    return schema.type === "object" && schema.additionalProperties === false
      ? [`\`${field}\` has no fields, so it is \`{}\`.`]
      : [`\`${field}\` is ${typeOf(schema)}.`];
  }
  return [
    `\`${field}\` has these fields:`,
    "",
    ...table(rows([schema], keys, "")),
  ];
}

function definition(name: string, schema: JsonSchema): string[] {
  const keys = Object.keys(schema.properties ?? {});
  return [
    `### \`${name}\``,
    "",
    ...paragraph(schema.description),
    ...(keys.length
      ? table(rows([schema], keys))
      : [`It is a ${typeOf(schema)}.`]),
  ];
}

export function renderSpec(): string {
  const clientSchema = jsonSchema(clientFrame);
  const serverSchema = jsonSchema(serverFrame);
  const client = framesOf(clientSchema);
  const server = framesOf(serverSchema);
  const definitions = {
    ...clientSchema.definitions,
    ...serverSchema.definitions,
  };
  const sections = [
    [
      "# Protocol spec",
      "",
      "<!-- Generated by packages/protocol/src/spec.test.ts. Don't edit this file. Regenerate: bun --bun vitest run -u packages/protocol -->",
      "",
      `This page lists the frames that the server and its clients exchange, for protocol version ${String(version)}. A test generates it from the schemas in [\`packages/protocol/src\`](https://github.com/jcore9/Aphelion/tree/dev/packages/protocol/src) and fails when this page is out of date. [The client protocol](protocol.md) explains replay, resync and command ids.`,
    ],
    [
      "## Envelope",
      "",
      "Every frame is one JSON object with these fields. A frame with a field that its type doesn't list is rejected.",
      "",
      ...table(rows([...client, ...server].flat(), envelopeKeys)),
    ],
    [
      "## Frames a client sends",
      ...client.flatMap((f) => ["", ...frameSection(f)]),
    ],
    [
      "## Frames the server sends",
      ...server.flatMap((f) => ["", ...frameSection(f)]),
    ],
    [
      "## Commands",
      "",
      "A `command` frame carries a command's `payload`, and the `result` frame that answers it carries the command's `result`.",
      ...Object.entries(commands).flatMap(([name, spec]) => [
        "",
        `### \`${name}\` command`,
        "",
        ...value("payload", jsonSchema(spec.payload)),
        "",
        ...value("result", jsonSchema(spec.result)),
      ]),
    ],
    [
      "## Events",
      "",
      "An `event` frame carries the event's `payload`.",
      ...Object.entries(events).flatMap(([name, payload]) => {
        const schema = jsonSchema(payload);
        return [
          "",
          `### \`${name}\` event`,
          "",
          ...paragraph(schema.description),
          ...value("payload", schema),
        ];
      }),
    ],
    [
      "## Shared types",
      ...Object.entries(definitions).flatMap(([name, schema]) => [
        "",
        ...definition(name, schema),
      ]),
    ],
    [
      "## Error codes",
      "",
      "An `error` frame's `code` is one of these. [The client protocol](protocol.md#errors) explains each one.",
      "",
      ...errorCodes.map((errorCode) => `- \`${errorCode}\``),
    ],
    [
      "## JSON Schema",
      "",
      `[\`client-frame.schema.json\`](${github}/client-frame.schema.json) describes the frames a client sends, and [\`server-frame.schema.json\`](${github}/server-frame.schema.json) describes the frames the server sends. Both are JSON Schema draft-07, generated by the same test. Use them to check frames, or to generate types, in another language.`,
    ],
  ];
  return `${sections.map((lines) => lines.join("\n")).join("\n\n")}\n`;
}
