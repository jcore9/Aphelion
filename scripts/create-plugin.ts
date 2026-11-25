import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  parsePluginManifest,
  pluginApiVersion,
  pluginManifestFile,
} from "../packages/plugin-sdk/src/index.ts";

const root = resolve(import.meta.dirname, "..");
const template = join(root, "templates/server-plugin");
const sdk = join(root, "packages/plugin-sdk");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { id: { type: "string" }, repository: { type: "string" } },
});
if (positionals.length !== 1 || positionals[0] === undefined) {
  fail(
    "usage: bun run create:plugin <destination> [--id <id>] [--repository <owner/name>]",
  );
}
const destination = resolve(positionals[0]);
const id = values.id ?? basename(destination);

if (existsSync(destination) && readdirSync(destination).length > 0) {
  fail(`${destination} already exists and isn't empty`);
}

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const writeJson = (path: string, value: unknown) => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

const manifest = {
  ...readJson(join(template, pluginManifestFile)),
  id,
  api: `^${pluginApiVersion}`,
  ...(values.repository === undefined ? {} : { repository: values.repository }),
};
const checked = parsePluginManifest(manifest);
if (!checked.ok) {
  const issues = checked.issues.map(
    ({ field, message }) => `${field ?? "manifest"} ${message}`,
  );
  fail(`can't create the plugin: ${issues.join("; ")}`);
}

cpSync(template, destination, {
  recursive: true,
  filter: (source) => {
    const [top] = relative(template, source).split("/");
    return top !== "node_modules" && top !== "dist" && top !== "release";
  },
});
writeJson(join(destination, pluginManifestFile), manifest);

const vendor = join(destination, "vendor");
mkdirSync(vendor);
execFileSync(process.execPath, ["pm", "pack", "--destination", vendor], {
  cwd: sdk,
  stdio: ["ignore", "ignore", "inherit"],
});
const [tarball, ...others] = readdirSync(vendor);
if (tarball === undefined || others.length > 0) {
  fail(`expected one SDK package in ${vendor}`);
}

const packageFile = join(destination, "package.json");
const packageJson = readJson(packageFile);
writeJson(packageFile, {
  ...packageJson,
  name: id,
  dependencies: {
    ...(packageJson["dependencies"] as Record<string, string>),
    "@aphelion/plugin-sdk": `file:./vendor/${tarball}`,
  },
});

console.log(`Created ${id} in ${destination}`);
console.log(`Next: cd ${destination} && bun install && bun run test`);
