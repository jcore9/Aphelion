import { Effect, Layer } from "effect";
import { PluginGrants } from "./grants";
import type { PluginHost } from "./host";
import { readManifest } from "./manifest-file";

export const fixtureGrants = Layer.succeed(PluginGrants, {
  hasApproval: () => Effect.succeed(true),
  allows: () => Effect.succeed(false),
});

export const startFixture = (host: typeof PluginHost.Service, path: string) =>
  Effect.gen(function* () {
    const { manifest, folder } = yield* readManifest(path);
    return yield* host.start(path, {
      id: manifest.id,
      version: manifest.version,
      folder,
      filesDigest: undefined,
    });
  });
