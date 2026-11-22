import js from "@eslint/js";
import type { Linter } from "eslint";
import { defineConfig } from "eslint/config";
import { builtinModules } from "node:module";
import tseslint from "typescript-eslint";

const adapterModules = [
  "packages/server/src/adapters/**",
  "packages/cli/src/adapters/**",
];
const webPackages = [
  "packages/protocol/**",
  "packages/plugin-sdk/**",
  "packages/client/**",
];
const sharedPackages = ["packages/protocol/**", "packages/plugin-sdk/**"];

const bunOnly =
  "Bun-only APIs belong in an adapter module under src/adapters/ in server or cli (decision 0007).";
const webOnly =
  "protocol, plugin-sdk and client use web-standard APIs only (decision 0007).";

const nodeModules = builtinModules.filter((name) => !name.startsWith("bun"));

const bunImports = { regex: "^bun(:|$)", message: bunOnly };
const nodeImports = {
  regex: `^(node:|(${nodeModules.join("|")})(/|$))`,
  message: webOnly,
};
const hostImports = {
  regex: "^@aphelion/(server|cli|client)(/|$)",
  message: "Web packages never import server, cli or client code.",
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
const browserGlobals = ["window", "document"].map((name) => ({
  name,
  message: "protocol and plugin-sdk also run in Bun and Node (decision 0007).",
}));

function restrict(
  imports: { regex: string; message: string }[],
  globals: { name: string; message: string }[],
): Linter.RulesRecord {
  return {
    "no-restricted-imports": ["error", { patterns: imports }],
    "no-restricted-globals": ["error", ...globals],
  };
}

export default defineConfig(
  { ignores: ["**/node_modules/", "**/dist/", "coverage/", "spikes/"] },
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
    files: ["**/*.{ts,tsx}"],
    rules: {
      ...restrict([bunImports], bunGlobals),
      "no-restricted-properties": [
        "error",
        { object: "globalThis", property: "Bun", message: bunOnly },
      ],
    },
  },
  {
    files: webPackages,
    rules: restrict(
      [bunImports, nodeImports, hostImports],
      [...bunGlobals, ...nodeGlobals],
    ),
  },
  {
    files: sharedPackages,
    rules: restrict(
      [bunImports, nodeImports, hostImports],
      [...bunGlobals, ...nodeGlobals, ...browserGlobals],
    ),
  },
  {
    files: adapterModules,
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-globals": "off",
      "no-restricted-properties": "off",
    },
  },
);
