import type {
  Decider,
  PermissionDecision,
  PermissionRequest,
  ReasonCode,
} from "./adapter.ts";

/**
 * Resolves every link in an absolute path that holds no `.` or `..` part.
 * It resolves to `undefined` when nothing exists at the path, not even a broken link, and rejects on any other failure.
 */
export type RealPath = (path: string) => Promise<string | undefined>;

const decide = (
  decision: PermissionDecision["decision"],
  reason: ReasonCode,
): PermissionDecision => ({ decision, by: "rule", reason });

const wildcard = /[*?[{(]/;

const alternativeAtRoot = /[{,|(]\s*[/~]/;

const segmentsOf = (path: string) =>
  path.split("/").filter((segment) => segment !== "" && segment !== ".");

const parentOf = (path: string) =>
  path.slice(0, Math.max(path.lastIndexOf("/"), 0)) || "/";

const childOf = (path: string, name: string) =>
  path === "/" ? `/${name}` : `${path}/${name}`;

const within = (root: string, path: string) =>
  root === "/" || path === root || path.startsWith(`${root}/`);

const normalized = (start: string, segments: readonly string[]) => {
  let path = start;
  for (const segment of segments) {
    path = segment === ".." ? parentOf(path) : childOf(path, segment);
  }
  return path;
};

const resolved = async (
  realpath: RealPath,
  start: string,
  segments: readonly string[],
) => {
  let path = start;
  for (const segment of segments) {
    if (segment === "..") {
      path = parentOf(path);
      continue;
    }
    const next = childOf(path, segment);
    path = (await realpath(next)) ?? next;
  }
  return path;
};

const splitAtWildcard = (segments: readonly string[]) => {
  const first = segments.findIndex((segment) => wildcard.test(segment));
  return first === -1
    ? { fixed: segments, rest: [] }
    : { fixed: segments.slice(0, first), rest: segments.slice(first) };
};

const restIsSafe = (rest: readonly string[]) =>
  !rest.some((segment) => segment.includes("..")) &&
  !alternativeAtRoot.test(rest.join("/"));

/**
 * The fixed rule for a bot before approvals exist. It allows file tools only inside the bot's folder, allows shell commands, and denies web and every other tool.
 * A path is resolved against the folder, `..` is applied, and every link is followed with `realpath`, so a link inside the folder that points out of it counts as outside.
 * A path that doesn't exist yet is judged by the nearest folder above it that does.
 * A pattern such as `src/*.ts` is judged by its fixed part before the first wildcard. A pattern with `..` after a wildcard is denied.
 * Each answer covers one request.
 */
export function folderRule(realpath: RealPath): Decider {
  const isInside = async (root: string, folder: string, path: string) => {
    if (path.startsWith("~") || path.includes("\\")) return false;
    const absolute = path.startsWith("/");
    const segments = segmentsOf(path);
    const { fixed, rest } = splitAtWildcard(segments);
    if (!restIsSafe(rest)) return false;
    const asKernelReads = absolute ? "/" : root;
    const asLibraryReads = absolute ? "/" : folder;
    const checks = [segments, fixed].flatMap((parts) => [
      resolved(realpath, asKernelReads, parts),
      resolved(realpath, "/", segmentsOf(normalized(asLibraryReads, parts))),
    ]);
    return (await Promise.all(checks)).every((real) => within(root, real));
  };

  const allInside = async (request: PermissionRequest, folder: string) => {
    if (request.truncated || request.paths.length === 0) return false;
    if (!folder.startsWith("/") || segmentsOf(folder).includes("..")) {
      return false;
    }
    const root = await realpath(normalized("/", segmentsOf(folder)));
    if (root === undefined) return false;
    const answers = await Promise.all(
      request.paths.map((path) => isInside(root, folder, path)),
    );
    return answers.every(Boolean);
  };

  return async (request, _signal, { folder }) => {
    switch (request.kind) {
      case "shell":
        return decide("allow", "shell");
      case "web":
        return decide("deny", "web");
      case "other":
        return decide("deny", "unknown-tool");
      case "file.read":
      case "file.write":
        try {
          return (await allInside(request, folder))
            ? decide("allow", "inside-folder")
            : decide("deny", "outside-folder");
        } catch {
          return decide("deny", "outside-folder");
        }
    }
  };
}
