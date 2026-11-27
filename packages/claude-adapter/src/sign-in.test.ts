import { afterEach, describe, expect, it } from "vitest";
import { fakeClaude, type FakeClaude } from "./fake-claude.ts";
import { claudeSignedIn, sessionEnv } from "./sign-in.ts";

const fakeKey = "sk-ant-api03-fake-sign-in-0123456789";

const parent = {
  HOME: "/var/lib/aphelion-bots",
  PATH: "/usr/bin:/bin",
  ANTHROPIC_API_KEY: fakeKey,
};

const made: FakeClaude[] = [];
const claude = (answer: Parameters<typeof fakeClaude>[0]) => {
  const fake = fakeClaude(answer);
  made.push(fake);
  return fake;
};

afterEach(() => {
  for (const fake of made.splice(0)) fake.remove();
});

describe("claudeSignedIn", () => {
  it("runs claude auth status without the API key and answers true when it exits 0", async () => {
    const fake = claude("signed-in");
    expect(await claudeSignedIn(parent, fake.path)).toBe(true);
    expect(fake.calls()).toEqual([
      "auth status key= home=/var/lib/aphelion-bots",
    ]);
  });

  it("answers false when claude auth status exits 1", async () => {
    const fake = claude("signed-out");
    expect(await claudeSignedIn(parent, fake.path)).toBe(false);
    expect(fake.calls()).toEqual([
      "auth status key= home=/var/lib/aphelion-bots",
    ]);
  });

  it("answers false when the CLI is missing", async () => {
    expect(await claudeSignedIn(parent, "/nonexistent/claude")).toBe(false);
  });

  it("answers false and kills the check when it runs past its limit", async () => {
    const fake = claude("hangs");
    const began = Date.now();
    expect(await claudeSignedIn(parent, fake.path, 200)).toBe(false);
    expect(Date.now() - began).toBeLessThan(3_000);
  });
});

describe("sessionEnv", () => {
  it("never runs the check when no API key came", async () => {
    let checks = 0;
    const env = await sessionEnv({ HOME: "/home/bots" }, () => {
      checks += 1;
      return Promise.resolve(false);
    });
    expect(checks).toBe(0);
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("leaves the key out when the sign-in works", async () => {
    const fake = claude("signed-in");
    const env = await sessionEnv(parent, (from) =>
      claudeSignedIn(from, fake.path),
    );
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env["HOME"]).toBe("/var/lib/aphelion-bots");
  });

  it("passes the key when there is no working sign-in", async () => {
    const fake = claude("signed-out");
    const env = await sessionEnv(parent, (from) =>
      claudeSignedIn(from, fake.path),
    );
    expect(env["ANTHROPIC_API_KEY"]).toBe(fakeKey);
  });
});
