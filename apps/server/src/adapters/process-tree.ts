import { dlopen, FFIType } from "bun:ffi";
import { readdirSync, readFileSync } from "node:fs";

export const PR_SET_DUMPABLE = 4;
export const PR_SET_CHILD_SUBREAPER = 36;

export const libc = () =>
  dlopen("libc.so.6", {
    prctl: {
      args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
      returns: FFIType.i32,
    },
    waitpid: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
  }).symbols;

export interface Proc {
  readonly pid: number;
  readonly parent: number;
  readonly started: string;
  readonly state: string;
}

export function read(pid: number): Proc | undefined {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return {
      pid,
      parent: Number(fields[1]),
      started: fields[19] ?? "",
      state: fields[0] ?? "",
    };
  } catch {
    return undefined;
  }
}

export const isStill = (proc: Proc) => read(proc.pid)?.started === proc.started;

export const isGone = (proc: Proc) => {
  const now = read(proc.pid);
  return now?.started !== proc.started || now.state === "Z";
};

const identity = (proc: Proc) => `${String(proc.pid)}:${proc.started}`;

export function childrenByParent(): Map<number, Proc[]> {
  const children = new Map<number, Proc[]>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const proc = read(Number(name));
    if (proc === undefined) continue;
    const siblings = children.get(proc.parent) ?? [];
    siblings.push(proc);
    children.set(proc.parent, siblings);
  }
  return children;
}

function treeOf(roots: readonly Proc[]): Proc[] {
  const children = childrenByParent();
  const tree: Proc[] = [];
  const queue = [...roots];
  for (let proc = queue.pop(); proc !== undefined; proc = queue.pop()) {
    tree.push(proc);
    queue.push(...(children.get(proc.pid) ?? []));
  }
  return tree;
}

function signal(proc: Proc, name: "SIGSTOP" | "SIGKILL"): void {
  if (!isStill(proc)) return;
  try {
    process.kill(proc.pid, name);
  } catch {
    return;
  }
}

export function freezeAndKill(roots: () => Proc[]): Proc[] {
  const frozen = new Map<string, Proc>();
  for (;;) {
    const fresh = treeOf(roots()).filter((proc) => !frozen.has(identity(proc)));
    if (fresh.length === 0) break;
    for (const proc of fresh) {
      signal(proc, "SIGSTOP");
      frozen.set(identity(proc), proc);
    }
  }
  for (const proc of frozen.values()) signal(proc, "SIGKILL");
  return [...frozen.values()];
}
