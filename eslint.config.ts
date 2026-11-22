import js from "@eslint/js";
import type { Linter } from "eslint";
import { defineConfig } from "eslint/config";
import { builtinModules } from "node:module";
import tseslint from "typescript-eslint";

const adapterModules = ["apps/server/src/adapters/**"];
const webPackages = [
  "packages/protocol/**",
  "packages/plugin-sdk/**",
  "packages/ui/**",
];

const bunOnly =
  "Bun-only APIs belong in an adapter module under apps/server/src/adapters/ (decisions 0007 and 0047).";
const webOnly =
  "protocol, plugin-sdk and ui use web-standard APIs only (decisions 0007 and 0047).";

const nodeModules = builtinModules.filter((name) => !name.startsWith("bun"));

const bunImports = { regex: "^bun(:|$)", message: bunOnly };
const effectBunImports = {
  regex: "^@effect/(platform-bun|sql-sqlite-bun)(/|$)",
  message:
    "@effect/platform-bun and @effect/sql-sqlite-bun use Bun-only APIs. Import them from an adapter module under apps/server/src/adapters/ (decisions 0007, 0041 and 0047).",
};
const effectImports = {
  regex: "^(effect|@effect/.+)(/|$)",
  message:
    "Only apps/server uses the Effect library. protocol, plugin-sdk and ui stay plain TypeScript (decision 0041).",
};
const nodeImports = {
  regex: `^(node:|(${nodeModules.join("|")})(/|$))`,
  message: webOnly,
};
const hostImports = {
  regex: "^@aphelion/(server|ui)(/|$)",
  message: "Web packages never import the server or ui packages.",
};

const bunGlobals = [{ name: "Bun", message: bunOnly }];
const nodeGlobals = [
  "process",
  "Buffer",
  "require",
  "module",
  "global",
  "__dirname",
  "__filename",
].map((name) => ({ name, message: webOnly }));

function restrict(
  imports: { regex: string; message: string }[],
  globals: { name: string; message: string }[],
): Linter.RulesRecord {
  const calls = imports.flatMap(({ regex, message }) => {
    const pattern = `/${regex.replaceAll("/", "\\u002F")}/`;
    return [
      {
        selector: `ImportExpression > Literal[value=${pattern}]`,
        message,
      },
      {
        selector: `ImportExpression > TemplateLiteral[expressions.length=0][quasis.0.value.cooked=${pattern}]`,
        message,
      },
    ];
  });
  return {
    "no-restricted-imports": ["error", { patterns: imports }],
    "no-restricted-syntax": ["error", ...calls],
    "no-restricted-globals": ["error", ...globals],
  };
}

export default defineConfig(
  {
    ignores: [
      "**/node_modules/",
      "**/dist/",
      "**/.astro/",
      "coverage/",
      "spikes/",
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    rules: {
      ...restrict([bunImports, effectBunImports], bunGlobals),
      "no-restricted-properties": [
        "error",
        { object: "globalThis", property: "Bun", message: bunOnly },
      ],
    },
  },
  {
    files: webPackages,
    rules: restrict(
      [bunImports, effectBunImports, effectImports, nodeImports, hostImports],
      [...bunGlobals, ...nodeGlobals],
    ),
  },
  {
    files: adapterModules,
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-syntax": "off",
      "no-restricted-globals": "off",
      "no-restricted-properties": "off",
    },
  },
);
