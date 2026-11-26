import { lstat, realpath } from "node:fs/promises";
import type { RealPath } from "@aphelion/plugin-sdk";

const isMissing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export const realpathOrMissing: RealPath = async (path) => {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const link = await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (link) throw new Error("the path is a broken link");
  return undefined;
};
