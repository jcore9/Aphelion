import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parsePluginManifest, pluginManifestFile } from "@aphelion/plugin-sdk";

const parsed = parsePluginManifest(
  JSON.parse(readFileSync(pluginManifestFile, "utf8")),
);
if (!parsed.ok) {
  for (const { field, message } of parsed.issues) {
    console.error(`${pluginManifestFile}: ${field ?? "manifest"} ${message}`);
  }
  process.exit(1);
}
mkdirSync("dist", { recursive: true });
writeFileSync(
  `dist/${pluginManifestFile}`,
  `${JSON.stringify({ ...parsed.manifest, server: { entry: "server.mjs" } }, null, 2)}\n`,
);
