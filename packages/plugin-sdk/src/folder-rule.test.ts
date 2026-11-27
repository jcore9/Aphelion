import { describe, expect, it } from "vitest";
import {
  permissionRequestId,
  toolCallId,
  type PermissionRequest,
  type ToolKind,
} from "./adapter.ts";
import { folderRule, type RealPath } from "./folder-rule.ts";

const folder = "/bots/one";

const fakeFiles = (
  existing: readonly string[],
  links: Readonly<Record<string, string>>,
): RealPath => {
  const present = new Set(existing);
  const resolve = (path: string): string | undefined => {
    let current = "";
    for (const segment of path.split("/").filter(Boolean)) {
      const next = `${current}/${segment}`;
      const target = links[next];
      if (target !== undefined) {
        const real = resolve(target);
        if (real === undefined) throw new Error("broken link");
        current = real;
      } else if (present.has(next)) {
        current = next;
      } else {
        return undefined;
      }
    }
    return current === "" ? "/" : current;
  };
  return (path) => Promise.resolve(resolve(path));
};

const files = fakeFiles(
  [
    "/bots",
    "/bots/one",
    "/bots/one/notes.md",
    "/bots/one/src",
    "/bots/one/src/app.ts",
    "/bots/one/src/deeper",
    "/bots/two",
    "/bots/two/secret.txt",
    "/etc",
    "/etc/passwd",
    "/real",
    "/real/one",
  ],
  {
    "/bots/one/out": "/bots/two",
    "/bots/one/back": "/bots/one/src",
    "/bots/one/deep": "/bots/one/src/deeper",
    "/bots/two/x*": "/bots/one",
    "/bots/one/broken": "/bots/two/missing.txt",
    "/bots/linked": "/real/one",
  },
);

const rule = folderRule(files);

const request = (
  kind: ToolKind,
  paths: readonly string[],
  extra: Partial<PermissionRequest> = {},
): PermissionRequest => ({
  request: permissionRequestId.parse("req-1"),
  call: toolCallId.parse("call-1"),
  tool: "Tool",
  kind,
  paths: [...paths],
  command: null,
  truncated: false,
  ...extra,
});

const answer = (
  kind: ToolKind,
  paths: readonly string[],
  extra: Partial<PermissionRequest> = {},
  at = folder,
) =>
  Promise.resolve(
    rule(request(kind, paths, extra), new AbortController().signal, {
      folder: at,
    }),
  );

const allowed = { decision: "allow", by: "rule", reason: "inside-folder" };
const outside = { decision: "deny", by: "rule", reason: "outside-folder" };

describe("folderRule for file tools", () => {
  it("allows a path inside the folder, absolute or relative", async () => {
    expect(await answer("file.read", ["/bots/one/notes.md"])).toEqual(allowed);
    expect(await answer("file.read", ["notes.md"])).toEqual(allowed);
    expect(await answer("file.read", ["./src/../notes.md"])).toEqual(allowed);
    expect(await answer("file.read", ["/bots/one"])).toEqual(allowed);
    expect(await answer("file.write", ["/bots/one/src/app.ts"])).toEqual(
      allowed,
    );
  });

  it("denies a path outside the folder", async () => {
    expect(await answer("file.read", ["/etc/passwd"])).toEqual(outside);
    expect(await answer("file.read", ["/bots/two/secret.txt"])).toEqual(
      outside,
    );
    expect(await answer("file.read", ["/bots/one-other/x"])).toEqual(outside);
    expect(await answer("file.write", ["/"])).toEqual(outside);
  });

  it("denies a path that climbs out with ..", async () => {
    expect(await answer("file.read", ["../two/secret.txt"])).toEqual(outside);
    expect(await answer("file.read", ["src/../../two/secret.txt"])).toEqual(
      outside,
    );
    expect(await answer("file.read", ["/bots/one/../two/secret.txt"])).toEqual(
      outside,
    );
    expect(await answer("file.read", [".."])).toEqual(outside);
  });

  it("follows a link inside the folder and judges where it points", async () => {
    expect(await answer("file.read", ["out/secret.txt"])).toEqual(outside);
    expect(await answer("file.read", ["/bots/one/out"])).toEqual(outside);
    expect(await answer("file.write", ["out/new.txt"])).toEqual(outside);
    expect(await answer("file.read", ["back/app.ts"])).toEqual(allowed);
  });

  it("judges .. after a link both the way the kernel reads it and the way a path library does", async () => {
    expect(await answer("file.read", ["out/../one/notes.md"])).toEqual(allowed);
    expect(await answer("file.read", ["back/../notes.md"])).toEqual(allowed);
    expect(await answer("file.read", ["out/../notes.md"])).toEqual(outside);
    expect(await answer("file.read", ["deep/../../x"])).toEqual(outside);
  });

  it("denies a broken link, whose target a write would create outside", async () => {
    expect(await answer("file.write", ["broken"])).toEqual(outside);
    expect(await answer("file.write", ["broken/x"])).toEqual(outside);
  });

  it("judges a new file by the folders above it", async () => {
    expect(await answer("file.write", ["/bots/one/new.txt"])).toEqual(allowed);
    expect(await answer("file.write", ["src/new/deeper/new.ts"])).toEqual(
      allowed,
    );
    expect(await answer("file.write", ["/bots/two/new.txt"])).toEqual(outside);
    expect(await answer("file.write", ["/nowhere/new.txt"])).toEqual(outside);
    expect(await answer("file.write", ["new/../../two/x"])).toEqual(outside);
  });

  it("judges a folder that is itself a link by where it points", async () => {
    expect(
      await answer("file.read", ["/real/one/a.txt"], {}, "/bots/linked"),
    ).toEqual(allowed);
    expect(await answer("file.read", ["a.txt"], {}, "/bots/linked")).toEqual(
      allowed,
    );
    expect(
      await answer(
        "file.read",
        ["/bots/linked/../two/secret.txt"],
        {},
        "/bots/linked",
      ),
    ).toEqual(outside);
  });

  it("denies a path that starts with ~, which a tool may read as the home folder", async () => {
    expect(await answer("file.read", ["~/.ssh/id_ed25519"])).toEqual(outside);
    expect(await answer("file.read", ["~"])).toEqual(outside);
    expect(await answer("file.read", ["~bot/x"])).toEqual(outside);
    expect(await answer("file.read", ["src/~x"])).toEqual(allowed);
  });

  it("allows a request only when every path is inside", async () => {
    expect(await answer("file.read", ["notes.md", "src/app.ts"])).toEqual(
      allowed,
    );
    expect(await answer("file.read", ["notes.md", "/etc/passwd"])).toEqual(
      outside,
    );
  });

  it("denies a file request with no paths, or with a path that was cut", async () => {
    expect(await answer("file.read", [])).toEqual(outside);
    expect(await answer("file.write", [])).toEqual(outside);
    expect(
      await answer("file.read", ["notes.md"], { truncated: true }),
    ).toEqual(outside);
  });

  it("denies every path when the folder isn't an absolute path that exists", async () => {
    expect(await answer("file.read", ["notes.md"], {}, "bots/one")).toEqual(
      outside,
    );
    expect(
      await answer("file.read", ["/bots/gone/x"], {}, "/bots/gone"),
    ).toEqual(outside);
  });

  it("denies a path the file system can't resolve", async () => {
    const failing = folderRule((path) =>
      path === "/bots/one"
        ? Promise.resolve(path)
        : Promise.reject(new Error("EACCES")),
    );
    expect(
      await failing(
        request("file.read", ["notes.md"]),
        new AbortController().signal,
        {
          folder,
        },
      ),
    ).toEqual(outside);
  });
});

describe("folderRule for patterns", () => {
  it("allows a pattern whose fixed part is inside the folder", async () => {
    expect(await answer("file.read", ["**/*.ts"])).toEqual(allowed);
    expect(await answer("file.read", ["src/**/*.{ts,tsx}"])).toEqual(allowed);
    expect(await answer("file.read", ["/bots/one/src/*.ts"])).toEqual(allowed);
    expect(await answer("file.read", ["src/[a-z]?.ts"])).toEqual(allowed);
  });

  it("denies a pattern whose fixed part is outside the folder", async () => {
    expect(await answer("file.read", ["/etc/*"])).toEqual(outside);
    expect(await answer("file.read", ["../*"])).toEqual(outside);
    expect(await answer("file.read", ["../two/**"])).toEqual(outside);
    expect(await answer("file.read", ["out/*"])).toEqual(outside);
    expect(await answer("file.read", ["/*"])).toEqual(outside);
    expect(await answer("file.read", ["out/x*"])).toEqual(outside);
  });

  it("denies a pattern that climbs with .. after a wildcard", async () => {
    expect(await answer("file.read", ["src/*/../../../etc/*"])).toEqual(
      outside,
    );
    expect(await answer("file.read", ["*/../notes.md"])).toEqual(outside);
    expect(await answer("file.read", ["src/{a,..}/x"])).toEqual(outside);
  });

  it("denies a pattern with an alternative that starts at the root or home", async () => {
    expect(await answer("file.read", ["{/etc,src}/*"])).toEqual(outside);
    expect(await answer("file.read", ["{src,~/.ssh}/*"])).toEqual(outside);
    expect(await answer("file.read", ["@(src|/etc)/*"])).toEqual(outside);
    expect(await answer("file.read", ["+(/etc)/*"])).toEqual(outside);
    expect(await answer("file.read", ["@(src|lib)/*"])).toEqual(allowed);
  });

  it("denies a pattern whose escapes or groups could hide a ..", async () => {
    expect(await answer("file.read", ["src/\\.\\./\\.\\./etc/*"])).toEqual(
      outside,
    );
    expect(await answer("file.read", ["@(..)/two/*"])).toEqual(outside);
    expect(await answer("file.read", ["src\\notes.md"])).toEqual(outside);
    expect(await answer("file.read", ["src/(draft) *.md"])).toEqual(allowed);
  });
});

describe("folderRule for other kinds", () => {
  it("allows a shell command, whatever it names", async () => {
    expect(await answer("shell", [], { command: "cat /etc/passwd" })).toEqual({
      decision: "allow",
      by: "rule",
      reason: "shell",
    });
    expect(await answer("shell", ["/etc"], { truncated: true })).toEqual({
      decision: "allow",
      by: "rule",
      reason: "shell",
    });
  });

  it("denies a web tool", async () => {
    expect(await answer("web", [])).toEqual({
      decision: "deny",
      by: "rule",
      reason: "web",
    });
  });

  it("denies any other tool", async () => {
    expect(await answer("other", [])).toEqual({
      decision: "deny",
      by: "rule",
      reason: "unknown-tool",
    });
    expect(await answer("other", ["notes.md"])).toEqual({
      decision: "deny",
      by: "rule",
      reason: "unknown-tool",
    });
  });
});
