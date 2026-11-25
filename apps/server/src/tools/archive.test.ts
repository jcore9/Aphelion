import { describe, expect, it } from "vitest";
import { parseArchiveListing } from "./archive";

const file = (name: string, kind = "-") =>
  `${kind}rwxr-xr-x runner/runner 321244472 2026-11-23 18:05 ${name}`;

describe("parseArchiveListing", () => {
  it("returns the regular files, whether or not names start with ./", () => {
    expect(
      parseArchiveListing(
        [
          file("./", "d"),
          file("./bin", "d"),
          file("./bin/tool"),
          file("README"),
        ].join("\n"),
      ),
    ).toEqual({ ok: true, value: ["bin/tool", "README"] });
  });

  it.each([
    ["a parent folder", file("../tool")],
    ["a path through a parent folder", file("bin/../../tool")],
    ["an absolute path", file("/etc/passwd")],
    ["a name with a space", file("my tool")],
    ["a symbolic link", file("tool -> /etc/passwd", "l")],
    ["a hard link", file("tool link to other", "h")],
    ["a device", file("null", "c")],
    ["a line that isn't a listing", "tar: something went wrong"],
  ])("refuses %s", (_label, row) => {
    expect(parseArchiveListing([file("fine"), row].join("\n")).ok).toBe(false);
  });
});
