import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  parsePluginManifest,
  pluginManifestFile,
  type ManifestIssue,
} from "@aphelion/plugin-sdk";
import { Data, Effect } from "effect";

export class PluginRefused extends Data.TaggedError("PluginRefused")<{
  readonly folder: string;
  readonly issues: readonly ManifestIssue[];
}> {}

export const readManifest = (folder: string) =>
  Effect.gen(function* () {
    const refuse = (message: string) =>
      new PluginRefused({ folder, issues: [{ message }] });
    if (!isAbsolute(folder)) {
      return yield* refuse("the plugin folder must be an absolute path");
    }
    const canonicalFolder = yield* Effect.tryPromise({
      try: () => realpath(folder),
      catch: () => refuse("the plugin folder couldn't be read"),
    });
    const text = yield* Effect.tryPromise({
      try: () => readFile(join(canonicalFolder, pluginManifestFile), "utf8"),
      catch: () => refuse(`can't read ${pluginManifestFile}`),
    });
    const data = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () => refuse(`${pluginManifestFile} isn't valid JSON`),
    });
    const parsed = parsePluginManifest(data);
    if (!parsed.ok) {
      return yield* new PluginRefused({ folder, issues: parsed.issues });
    }
    return { manifest: parsed.manifest, folder: canonicalFolder };
  });
