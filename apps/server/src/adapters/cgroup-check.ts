import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

export interface ProbeRequest {
  readonly tree: string;
  readonly leaf: string;
  readonly folder: string;
  readonly fifos: readonly string[];
}

export const maxAllowed = 64;

const codeOf = (error: unknown) =>
  (error as NodeJS.ErrnoException).code ?? "unknown";

export const outcome = (attempt: () => void) => {
  try {
    attempt();
    return "ok";
  } catch (error) {
    return codeOf(error);
  }
};

const denied = (code: string) => code === "EACCES" || code === "EPERM";

export function checkTree(request: ProbeRequest): string[] {
  const allowed: string[] = [];
  const work = join(request.tree, "work");
  const sibling = (path: string) =>
    path.startsWith(`${work}/`) &&
    path !== request.leaf &&
    !path.startsWith(`${request.leaf}/`);
  const note = (what: string, path: string, code: string) => {
    if (code !== "ENOENT" || !sibling(path)) {
      allowed.push(`${what} ${path}: ${code}`);
    }
  };
  const check = (what: string, path: string, attempt: () => void) => {
    const code = outcome(attempt);
    if (!denied(code)) note(what, path, code);
  };
  const must = <A>(what: string, path: string, read: () => A) => {
    try {
      return read();
    } catch (error) {
      note(what, path, codeOf(error));
      return undefined;
    }
  };
  const visit = (path: string) => {
    const info = must("find", path, () => statSync(path));
    if (info === undefined) return;
    if (!info.isDirectory()) {
      check("write", path, () => {
        closeSync(openSync(path, constants.O_WRONLY));
      });
      return;
    }
    const names = must("list", path, () => readdirSync(path)) ?? [];
    for (const name of names) visit(join(path, name));
    check("mkdir", path, () => {
      mkdirSync(join(path, "probe"));
    });
  };
  visit(request.tree);
  must("find", request.leaf, () => statSync(request.leaf));
  check("list", request.folder, () => readdirSync(request.folder));
  for (const fifo of request.fifos) {
    check("open", fifo, () => {
      closeSync(openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK));
    });
  }
  return allowed.slice(0, maxAllowed);
}
