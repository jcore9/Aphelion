import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { expect, test } from "vitest";

const eslint = new ESLint({
  cwd: import.meta.dirname,
  overrideConfig: tseslint.configs.disableTypeChecked,
});

async function lint(filePath: string, code: string): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath });
  return results.flatMap((result) =>
    result.messages.map((message) => message.ruleId ?? message.message),
  );
}

const code = {
  bunImport:
    'import { Database } from "bun:sqlite";\nexport const db = Database;\n',
  bunModule: 'import { $ } from "bun";\nexport const shell = $;\n',
  bunGlobal: "export const version = Bun.version;\n",
  globalThisBun: "export const version = globalThis.Bun.version;\n",
  nodeImport:
    'import { readFile } from "node:fs/promises";\nexport const read = readFile;\n',
  bareNodeImport:
    'import { join } from "path";\nexport const joinPath = join;\n',
  processGlobal: "export const env = process.env;\n",
  serverImport:
    'import * as server from "@aphelion/server";\nexport const host = server;\n',
  dynamicBunImport: 'export const load = () => import("bun:sqlite");\n',
  requireBun: 'export const bun: unknown = require("bun");\n',
  effectBunImport:
    'import { BunHttpServer } from "@effect/platform-bun";\nexport const http = BunHttpServer;\n',
  effectSqliteSubpath:
    'import { SqliteClient } from "@effect/sql-sqlite-bun/SqliteClient";\nexport const sql = SqliteClient;\n',
  effectImport:
    'import { Effect } from "effect";\nexport const run = Effect.succeed(1);\n',
  effectSubpathImport:
    'import { HttpRouter } from "effect/http";\nexport const router = HttpRouter;\n',
  effectScopedImport:
    'import * as vitest from "@effect/vitest";\nexport const v = vitest;\n',
  dynamicEffectBunTemplate:
    "export const load = () => import(`@effect/platform-bun`);\n",
  reexportEffectBun: 'export * from "@effect/platform-bun";\n',
  dynamicNodeImport: 'export const load = () => import("fs/promises");\n',
  dynamicServerImport:
    'export const load = () => import("@aphelion/server/store");\n',
};

const imports = "no-restricted-imports";
const globals = "no-restricted-globals";
const properties = "no-restricted-properties";
const syntax = "no-restricted-syntax";

test.each([
  ["packages/server/src/store.ts", "bunImport", [imports]],
  ["packages/server/src/store.ts", "bunModule", [imports]],
  ["packages/server/src/store.ts", "bunGlobal", [globals]],
  ["packages/server/src/store.ts", "globalThisBun", [properties]],
  ["packages/server/src/adapters/store.ts", "bunImport", []],
  ["packages/server/src/adapters/store.ts", "bunGlobal", []],
  ["packages/server/src/adapters/store.ts", "globalThisBun", []],
  ["packages/cli/src/adapters/build.ts", "bunModule", []],
  ["packages/client/src/adapters/store.ts", "bunImport", [imports]],
  ["packages/plugin-sdk/src/index.ts", "bunGlobal", [globals]],
  ["packages/server/src/config.ts", "nodeImport", []],
  ["packages/server/src/config.ts", "processGlobal", []],
  ["packages/protocol/src/frame.ts", "nodeImport", [imports]],
  ["packages/plugin-sdk/src/index.ts", "bareNodeImport", [imports]],
  ["packages/protocol/src/frame.ts", "processGlobal", [globals]],
  ["packages/client/src/main.ts", "processGlobal", [globals]],
  ["packages/plugin-sdk/src/index.ts", "serverImport", [imports]],
  ["packages/client/src/main.ts", "serverImport", [imports]],
  ["packages/server/src/store.ts", "dynamicBunImport", [syntax]],
  [
    "packages/server/src/store.ts",
    "requireBun",
    ["@typescript-eslint/no-require-imports"],
  ],
  ["packages/server/src/adapters/store.ts", "dynamicBunImport", []],
  ["packages/server/src/http.ts", "effectBunImport", [imports]],
  ["packages/cli/src/main.ts", "effectBunImport", [imports]],
  ["packages/server/src/store.ts", "effectSqliteSubpath", [imports]],
  ["packages/protocol/src/frame.ts", "effectBunImport", [imports, imports]],
  ["packages/server/src/adapters/http.ts", "effectBunImport", []],
  ["packages/server/src/adapters/store.ts", "effectSqliteSubpath", []],
  ["packages/cli/src/adapters/run.ts", "effectBunImport", []],
  ["packages/server/src/http.ts", "effectImport", []],
  ["packages/cli/src/main.ts", "effectImport", []],
  ["packages/protocol/src/frame.ts", "effectImport", [imports]],
  ["packages/plugin-sdk/src/index.ts", "effectImport", [imports]],
  ["packages/client/src/main.ts", "effectImport", [imports]],
  ["packages/protocol/src/frame.ts", "effectSubpathImport", [imports]],
  ["packages/client/src/main.ts", "effectScopedImport", [imports]],
  ["packages/server/src/http.ts", "effectSubpathImport", []],
  ["packages/cli/src/main.ts", "effectSubpathImport", []],
  ["packages/server/src/http.ts", "dynamicEffectBunTemplate", [syntax]],
  ["packages/server/src/adapters/http.ts", "dynamicEffectBunTemplate", []],
  ["packages/cli/src/main.ts", "reexportEffectBun", [imports]],
  ["packages/server/src/adapters/http.ts", "reexportEffectBun", []],
  ["packages/server/src/http.js", "effectBunImport", [imports]],
  ["packages/cli/src/main.mjs", "bunImport", [imports]],
  ["packages/server/src/adapters/http.js", "effectBunImport", []],
  ["packages/server/src/config.ts", "dynamicNodeImport", []],
  ["packages/protocol/src/frame.ts", "dynamicNodeImport", [syntax]],
  ["packages/client/src/main.ts", "dynamicServerImport", [syntax]],
] as const)("%s with %s reports %j", async (filePath, snippet, expected) => {
  expect(await lint(filePath, code[snippet])).toEqual(expected);
});
