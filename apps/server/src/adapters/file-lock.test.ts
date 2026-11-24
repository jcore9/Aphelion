import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { lockFile } from "./file-lock";

function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "aphelion-lock-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true });
  });
  return join(dir, "plugin-files.lock");
}

test("admits one owner at a time and frees the lock on release", () => {
  const path = lockPath();
  const first = lockFile(path);
  expect(first.kind).toBe("locked");
  expect(lockFile(path)).toEqual({ kind: "held" });
  if (first.kind === "locked") first.release();
  const again = lockFile(path);
  expect(again.kind).toBe("locked");
  if (again.kind === "locked") again.release();
});

test("frees the lock when the process that holds it is killed", async () => {
  const path = lockPath();
  const holder = spawn(
    process.execPath,
    [
      "-e",
      `const { lockFile } = await import(${JSON.stringify(join(import.meta.dirname, "file-lock.ts"))});
       console.log(lockFile(process.argv[1]).kind);
       setInterval(() => {}, 1000);`,
      path,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const said = await new Promise<string>((resolve) => {
    holder.stdout.once("data", (chunk: Buffer) => {
      resolve(chunk.toString().trim());
    });
  });
  expect(said).toBe("locked");
  expect(lockFile(path)).toEqual({ kind: "held" });
  const exited = new Promise((resolve) => holder.once("exit", resolve));
  holder.kill("SIGKILL");
  await exited;
  const after = lockFile(path);
  expect(after.kind).toBe("locked");
  if (after.kind === "locked") after.release();
});
