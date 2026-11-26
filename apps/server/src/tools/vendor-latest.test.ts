import { describe, expect, it } from "vitest";
import {
  checkState,
  claudeBase,
  compareVersions,
  grokHosts,
  lookupLatest,
  type Fetcher,
} from "./vendor-latest";

type Answers = Record<string, Response | Error>;

function fakeFetch(answers: Answers) {
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const fetcher = ((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    const answer = answers[url];
    if (answer === undefined) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer.clone());
  }) as Fetcher;
  return { fetcher, asked };
}

const text = (body: string, status = 200) => new Response(body, { status });

const codexLatest = "https://api.github.com/repos/openai/codex/releases/latest";
const opencodeReleases =
  "https://api.github.com/repos/anomalyco/opencode/releases?per_page=10";

const release = (tag: string, flags: Record<string, boolean> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  assets: [{ name: "huge", size: 1 }],
  ...flags,
});

describe("lookupLatest for Claude Code", () => {
  it("reads the version file of the release channel", async () => {
    const { fetcher, asked } = fakeFetch({
      [`${claudeBase}/latest`]: text("2.1.332\n"),
    });
    expect(await lookupLatest("claude", fetcher)).toEqual({
      ok: true,
      value: "2.1.332",
    });
    expect(asked.map(({ url }) => url)).toEqual([`${claudeBase}/latest`]);
  });

  it.each([
    ["a page that isn't a version", "<html>maintenance</html>"],
    ["a version with a suffix", "2.1.332-beta"],
    ["an empty file", ""],
    ["two lines", "2.1.332\n2.1.333"],
  ])("refuses %s", async (_label, body) => {
    const { fetcher } = fakeFetch({ [`${claudeBase}/latest`]: text(body) });
    expect((await lookupLatest("claude", fetcher)).ok).toBe(false);
  });

  it("says what went wrong when the vendor answers an error or doesn't answer", async () => {
    const down = fakeFetch({ [`${claudeBase}/latest`]: text("", 503) });
    expect(await lookupLatest("claude", down.fetcher)).toEqual({
      ok: false,
      message: `${claudeBase}/latest answered 503`,
    });
    const broken = fakeFetch({
      [`${claudeBase}/latest`]: new Error("connection reset"),
    });
    expect(await lookupLatest("claude", broken.fetcher)).toEqual({
      ok: false,
      message: `can't reach ${claudeBase}/latest: connection reset`,
    });
  });

  it("refuses an answer bigger than the cap", async () => {
    const { fetcher } = fakeFetch({
      [`${claudeBase}/latest`]: text("2".repeat(5 * 1024 * 1024)),
    });
    const found = await lookupLatest("claude", fetcher);
    expect(found.ok).toBe(false);
  });

  it("gives each lookup a timeout", async () => {
    let signal: AbortSignal | undefined;
    const fetcher = ((_input: string | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }) as Fetcher;
    const pending = lookupLatest("claude", fetcher, { timeoutMs: 20 });
    await expect(pending).resolves.toMatchObject({ ok: false });
    expect(signal?.aborted).toBe(true);
  });
});

describe("lookupLatest for Grok Build", () => {
  const [primary, mirror] = grokHosts;

  it("reads the stable channel file from xAI's first host", async () => {
    const { fetcher, asked } = fakeFetch({
      [`${primary}/stable`]: text("1.0.92\n"),
    });
    expect(await lookupLatest("grok", fetcher)).toEqual({
      ok: true,
      value: "1.0.92",
    });
    expect(asked).toHaveLength(1);
  });

  it("falls back to the second host when the first doesn't answer", async () => {
    const { fetcher, asked } = fakeFetch({
      [`${primary}/stable`]: text("", 502),
      [`${mirror}/stable`]: text("1.0.93"),
    });
    expect(await lookupLatest("grok", fetcher)).toEqual({
      ok: true,
      value: "1.0.93",
    });
    expect(asked.map(({ url }) => url)).toEqual([
      `${primary}/stable`,
      `${mirror}/stable`,
    ]);
  });

  it("reports the failure when neither host answers", async () => {
    const { fetcher } = fakeFetch({});
    expect(await lookupLatest("grok", fetcher)).toEqual({
      ok: false,
      message: `${primary}/stable answered 404; ${mirror}/stable answered 404`,
    });
  });
});

describe("lookupLatest for Codex", () => {
  it("reads the tag of GitHub's latest release", async () => {
    const { fetcher, asked } = fakeFetch({
      [codexLatest]: text(JSON.stringify(release("rust-v0.172.0"))),
    });
    expect(await lookupLatest("codex", fetcher)).toEqual({
      ok: true,
      value: "0.172.0",
    });
    expect(asked[0]?.headers["accept"]).toBe("application/vnd.github+json");
    expect(asked[0]?.headers["authorization"]).toBeUndefined();
  });

  it.each([
    [
      "a prerelease",
      JSON.stringify(release("rust-v0.173.0", { prerelease: true })),
    ],
    ["a draft", JSON.stringify(release("rust-v0.173.0", { draft: true }))],
    ["another tag", JSON.stringify(release("v0.173.0"))],
    ["an alpha tag", JSON.stringify(release("rust-v0.173.0-alpha.1"))],
    ["JSON without a tag", JSON.stringify({ assets: [] })],
    ["text that isn't JSON", "rate limited"],
  ])("refuses %s", async (_label, body) => {
    const { fetcher } = fakeFetch({ [codexLatest]: text(body) });
    expect((await lookupLatest("codex", fetcher)).ok).toBe(false);
  });
});

describe("lookupLatest for OpenCode", () => {
  it("picks the highest plain version among the recent releases", async () => {
    const { fetcher } = fakeFetch({
      [opencodeReleases]: text(
        JSON.stringify([
          release("v2.4.2"),
          release("v2.4.10"),
          release("v10.0.0", { prerelease: true }),
          release("v11.0.0", { draft: true }),
          release("process-daemon-v0.9.0"),
          release("v2.4.9"),
          release("v1.19.6"),
        ]),
      ),
    });
    expect(await lookupLatest("opencode", fetcher)).toEqual({
      ok: true,
      value: "2.4.10",
    });
  });

  it("refuses a list with no plain version release, and an answer that isn't a list", async () => {
    const none = fakeFetch({
      [opencodeReleases]: text(
        JSON.stringify([release("process-daemon-v0.6.0")]),
      ),
    });
    expect((await lookupLatest("opencode", none.fetcher)).ok).toBe(false);
    const object = fakeFetch({
      [opencodeReleases]: text(JSON.stringify({ message: "API rate limit" })),
    });
    expect((await lookupLatest("opencode", object.fetcher)).ok).toBe(false);
  });
});

describe("compareVersions", () => {
  it.each([
    ["2.1.332", "2.1.330", 1],
    ["2.1.330", "2.1.330", 0],
    ["2.1.330", "2.1.332", -1],
    ["2.10.0", "2.9.0", 1],
    ["10.0.0", "9.99.99", 1],
  ])("%s against %s is %d", (a, b, expected) => {
    expect(Math.sign(compareVersions(a, b))).toBe(expected);
  });
});

describe("checkState", () => {
  it("says newer version available only when the vendor's version is higher", () => {
    expect(checkState("2.1.330", { ok: true, value: "2.1.332" })).toBe(
      "newer version available",
    );
    expect(checkState("2.1.330", { ok: true, value: "2.1.330" })).toBe(
      "current",
    );
    expect(checkState("2.1.330", { ok: true, value: "2.1.326" })).toBe(
      "current",
    );
  });

  it("says unknown when the lookup failed", () => {
    expect(checkState("2.1.330", { ok: false, message: "down" })).toBe(
      "unknown",
    );
  });
});
