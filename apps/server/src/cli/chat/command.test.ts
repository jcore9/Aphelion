import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { capture } from "../testing";
import { run } from "../testing";
import { chatWith, normalizeUrl, type ChatEnvironment } from "./command";
import { fileCursorStore } from "./cursor-file";
import { Unauthorized } from "./session";
import { testHost } from "./test-host";

const token = `aph_dev_0123456789abcdef_${"a".repeat(43)}`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aphelion-chat-command-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const tokenFile = async (content: string, mode: number) => {
  const path = join(dir, "token");
  await writeFile(path, content, { mode });
  return path;
};

const environment = (
  over: Partial<ChatEnvironment> = {},
  seen: string[] = [],
): ChatEnvironment => ({
  host: testHost((_url, bearer) => {
    seen.push(bearer);
    return Promise.reject(new Unauthorized());
  }),
  isTerminal: false,
  promptToken: () => Promise.resolve(token),
  ...over,
});

const options = (over: Record<string, string | undefined> = {}) => ({
  bot: "chief",
  url: "ws://127.0.0.1:7400/ws",
  tokenFile: undefined,
  cursorFile: undefined,
  ...over,
});

describe("the device token", () => {
  test("is read from a private file, and never printed", async () => {
    const seen: string[] = [];
    const path = await tokenFile(`${token}\n`, 0o600);

    const { code, err } = await capture(
      chatWith(options({ tokenFile: path }), environment({}, seen)),
    );

    expect(seen).toEqual([token]);
    expect(code).toBe(1);
    expect(err.join("\n")).not.toContain(token);
  });

  test.each([0o640, 0o604, 0o660])(
    "is refused from a file with mode %o that others can read",
    async (mode) => {
      const seen: string[] = [];
      const path = await tokenFile(token, 0o600);
      const { chmod } = await import("node:fs/promises");
      await chmod(path, mode);

      const { code, out, err } = await capture(
        chatWith(options({ tokenFile: path }), environment({}, seen)),
      );

      expect(code).toBe(2);
      expect(seen).toEqual([]);
      expect(out).toEqual([]);
      expect(err[0]).toBe(
        `aphelion: ${path} can be read by other users; run chmod 600 on it`,
      );
      expect(err.join("\n")).not.toContain(token);
    },
  );

  test("is refused from a file that holds something else, without echoing it", async () => {
    const path = await tokenFile("hunter2-not-a-token", 0o600);

    const { code, err } = await capture(
      chatWith(options({ tokenFile: path }), environment()),
    );

    expect(code).toBe(2);
    expect(err[0]).toBe(`aphelion: ${path} doesn't hold a device token`);
    expect(err.join("\n")).not.toContain("hunter2");
  });

  test("is refused from a file that isn't there", async () => {
    const path = join(dir, "missing");

    const { code, err } = await capture(
      chatWith(options({ tokenFile: path }), environment()),
    );

    expect(code).toBe(2);
    expect(err[0]).toBe(`aphelion: can't read ${path}`);
  });

  test("is asked for when there is a terminal and no file", async () => {
    const seen: string[] = [];

    const { code } = await capture(
      chatWith(options(), environment({ isTerminal: true }, seen)),
    );

    expect(seen).toEqual([token]);
    expect(code).toBe(1);
  });

  test("is refused from a prompt that gets something else", async () => {
    const { code, err } = await capture(
      chatWith(
        options(),
        environment({
          isTerminal: true,
          promptToken: () => Promise.resolve("not a token"),
        }),
      ),
    );

    expect(code).toBe(2);
    expect(err[0]).toBe("aphelion: that isn't a device token");
    expect(err.join("\n")).not.toContain("not a token");
  });

  test("makes exit 2 with a fixed message when there is no file and no terminal", async () => {
    const seen: string[] = [];

    const { code, err } = await capture(
      chatWith(options(), environment({}, seen)),
    );

    expect(code).toBe(2);
    expect(seen).toEqual([]);
    expect(err[0]).toBe(
      "aphelion: no device token. Pass --token-file PATH, or run in a terminal to be asked for it.",
    );
  });
});

describe("the chat command line", () => {
  test.each([
    ["chat"],
    ["chat", "Chief"],
    ["chat", "chief", "extra"],
    ["chat", "chief", "--token", "aph_dev_0123456789abcdef_secret"],
    ["chat", "chief", "--url", "ftp://host/ws"],
    ["chat", "chief", "--url", "aph_dev_0123456789abcdef_secret"],
    ["chat", "chief", "--url"],
    ["chat", "chief", "--token-file"],
    ["chat", "chief", "--cursor-file", ""],
  ])("%j exits 2 and never echoes the input", async (...argv) => {
    const { code, out, err } = await run(argv);

    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err).toHaveLength(2);
    expect(err[0]).toMatch(/^aphelion: /);
    expect(err.join("\n")).not.toContain("aph_dev_");
    expect(err.join("\n")).not.toContain("ftp://");
  });

  test("is listed in the help", async () => {
    const { out } = await run(["--help"]);

    expect(out.join("\n")).toContain("chat");
  });
});

describe("the URL", () => {
  test.each([
    ["http://100.71.226.67:7400", "ws://100.71.226.67:7400/ws"],
    ["https://bots.example", "wss://bots.example/ws"],
    ["ws://100.71.226.67:7400/", "ws://100.71.226.67:7400/ws"],
    ["ws://100.71.226.67:7400/ws", "ws://100.71.226.67:7400/ws"],
    ["wss://bots.example/ws", "wss://bots.example/ws"],
  ])("%s becomes %s", (given, expected) => {
    expect(normalizeUrl(given)).toBe(expected);
  });

  test.each(["ftp://host/ws", "host:7400", "not a url", "ws://host/other"])(
    "%s is refused",
    (given) => {
      expect(() => normalizeUrl(given)).toThrow();
    },
  );
});

describe("the cursor file", () => {
  const stream = "s1";

  test("starts empty when there is no file", () => {
    expect(fileCursorStore(join(dir, "cursor")).load()).toBeNull();
  });

  test("keeps the last cursor, in a file only its owner can use", async () => {
    const path = join(dir, "cursor");
    const store = fileCursorStore(path);

    store.save({ stream: stream as never, seq: 3 });
    store.save({ stream: stream as never, seq: 4 });

    expect(fileCursorStore(path).load()).toEqual({ stream, seq: 4 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      stream,
      seq: 4,
    });
  });

  test("starts empty when the file holds something else", async () => {
    const path = join(dir, "cursor");
    await writeFile(path, '{"stream":1}', { mode: 0o600 });

    expect(fileCursorStore(path).load()).toBeNull();
  });
});
