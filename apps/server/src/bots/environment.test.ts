import { afterEach, describe, expect, it } from "vitest";
import { botEnvironment } from "./environment";

const proxyNames = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"];

describe("botEnvironment", () => {
  afterEach(() => {
    for (const name of proxyNames) Reflect.deleteProperty(process.env, name);
  });

  it("gives a Claude bot the shared bot home and switches off Claude Code's auto-updater", () => {
    expect(botEnvironment("claude", "/var/lib/aphelion-bots")).toEqual({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/var/lib/aphelion-bots",
      LANG: "C.UTF-8",
      TZ: "UTC",
      TMPDIR: "/tmp",
      DISABLE_AUTOUPDATER: "1",
    });
  });

  it("sets no auto-updater switch for another provider", () => {
    expect(botEnvironment("grok", "/var/lib/aphelion-bots")).toEqual({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/var/lib/aphelion-bots",
      LANG: "C.UTF-8",
      TZ: "UTC",
      TMPDIR: "/tmp",
    });
  });

  it("sets no proxy variable, even when the runner's own environment has them", () => {
    for (const name of proxyNames) process.env[name] = "http://proxy.test:3128";
    for (const provider of ["claude", "grok"]) {
      const names = Object.keys(botEnvironment(provider, "/home"));
      for (const name of proxyNames) expect(names).not.toContain(name);
    }
  });
});
