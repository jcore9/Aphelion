import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateIdentity } from "age-encryption";
import { describe, expect, it } from "vitest";

const broker = fileURLToPath(new URL("./broker-main.ts", import.meta.url));

function checkKey(input: string) {
  return spawnSync(process.execPath, [broker, "--check-key"], {
    input,
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("aphelion-secrets --check-key", () => {
  it("exits 0 for a generated key and prints a fixed message", async () => {
    const key = await generateIdentity();
    const result = checkKey(`${key}\n`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("The bootstrap key is a valid age identity\n");
    expect(result.stdout + result.stderr).not.toContain(key);
  });

  it("exits 1 for a key the old regex accepts, without printing it", () => {
    const shaped = `AGE-SECRET-KEY-1${"Q".repeat(58)}`;
    const result = checkKey(`${shaped}\n`);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "The bootstrap key is not a valid age identity",
    );
    expect(result.stdout + result.stderr).not.toContain(shaped);
  });

  it("exits 1 when standard input is empty", () => {
    const result = checkKey("");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "The bootstrap key is missing from standard input",
    );
  });

  it("exits 1 for a key longer than 1 KiB without printing it", () => {
    const long = "A".repeat(2000);
    const result = checkKey(long);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(long);
  });

  it("takes no other arguments", () => {
    const result = spawnSync(process.execPath, [broker, "--check-key", "x"], {
      input: "",
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--check-key");
  });
});
