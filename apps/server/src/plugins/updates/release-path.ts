import { pluginManifestSchema } from "@aphelion/plugin-sdk";

const releaseVersion =
  /^(?:0|[1-9]\d{0,14})\.(?:0|[1-9]\d{0,14})\.(?:0|[1-9]\d{0,14})$/;

export const isReleaseVersion = (version: string) =>
  releaseVersion.test(version) && version.trim() === version;

export const isReleaseDirectoryName = (name: string) => {
  const at = name.indexOf("@");
  return (
    at > 0 &&
    pluginManifestSchema.shape.id.safeParse(name.slice(0, at)).success &&
    isReleaseVersion(name.slice(at + 1))
  );
};
