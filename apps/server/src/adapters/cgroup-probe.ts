import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readdirSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

interface ProbeRequest {
  readonly tree: string;
  readonly folder: string;
  readonly fifos: readonly string[];
}

const outcome = (attempt: () => void) => {
  try {
    attempt();
    return "ok";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "unknown";
  }
};

const denied = (code: string) => code === "EACCES" || code === "EPERM";

function walk(folder: string, found: string[]): void {
  found.push(folder);
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) walk(path, found);
    else found.push(path);
  }
}

function probe(request: ProbeRequest): string[] {
  const allowed: string[] = [];
  const check = (what: string, attempt: () => void) => {
    const code = outcome(attempt);
    if (!denied(code)) allowed.push(`${what}: ${code}`);
  };
  const paths: string[] = [];
  walk(request.tree, paths);
  for (const path of paths) {
    if (statSync(path).isDirectory()) {
      check(`mkdir ${path}`, () => {
        mkdirSync(join(path, "probe"));
      });
    } else {
      check(`write ${path}`, () => {
        closeSync(openSync(path, constants.O_WRONLY));
      });
    }
  }
  check(`list ${request.folder}`, () => readdirSync(request.folder));
  for (const fifo of request.fifos) {
    check(`open ${fifo}`, () => {
      closeSync(openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK));
    });
  }
  return allowed;
}

outcome(() => {
  rmdirSync(process.cwd());
});
for await (const line of createInterface({ input: process.stdin })) {
  const allowed = probe(JSON.parse(line) as ProbeRequest);
  process.stdout.write(`${JSON.stringify({ allowed })}\n`);
}
setInterval(() => undefined, 60_000);
