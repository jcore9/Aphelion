import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parsePluginManifest,
  pluginManifestFile,
} from "../packages/plugin-sdk/src/index.ts";
import {
  readTar,
  writeEntries,
} from "../apps/server/src/plugins/updates/tar.ts";

const [archive, folder] = process.argv.slice(2);
if (archive === undefined || folder === undefined) {
  console.error(
    "usage: bun scripts/check-plugin-archive.ts <archive> <new folder>",
  );
  process.exit(1);
}

const unpacked = readTar(readFileSync(archive));
if (!unpacked.ok) {
  console.error(`Aphelion refuses ${archive}: ${unpacked.reason}.`);
  process.exit(1);
}
mkdirSync(folder);
await writeEntries(unpacked.entries, folder);
const manifest = parsePluginManifest(
  JSON.parse(readFileSync(join(folder, pluginManifestFile), "utf8")),
);
if (!manifest.ok) {
  for (const issue of manifest.issues) console.error(issue.message);
  process.exit(1);
}
console.log(
  `Aphelion unpacks ${manifest.manifest.id} ${manifest.manifest.version} from ${archive}.`,
);
