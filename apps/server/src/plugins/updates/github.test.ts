import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { downloadLimits, githubClient } from "./github";
import { UpdateRefused } from "./refused";

const releaseJson = readFileSync(
  join(
    import.meta.dirname,
    "fixtures/aphelion-test-plugin/v1.1.0/release.json",
  ),
  "utf8",
);
const repository = "jcore9-bot/aphelion-test-plugin";
const archiveUrl = `https://github.com/${repository}/releases/download/v1.1.0/aphelion-plugin.tar`;

type Route = (url: URL, init: RequestInit) => Response;

function fakeFetch(routes: Record<string, Route>) {
  const seen: string[] = [];
  const fetcher = ((input: URL, init?: RequestInit) => {
    const url = new URL(input);
    seen.push(url.href);
    const route = routes[`${url.origin}${url.pathname}`];
    return Promise.resolve(
      route === undefined
        ? new Response("missing", { status: 404 })
        : route(url, init ?? {}),
    );
  }) as typeof fetch;
  return { fetcher, seen };
}

const redirect = (location: string) => () =>
  new Response(null, { status: 302, headers: { location } });

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UpdateRefused) return error.reason;
    throw error;
  }
  return undefined;
};

describe("latestRelease", () => {
  test("reads the version and asset links of the latest full release", async () => {
    const { fetcher, seen } = fakeFetch({
      [`https://api.github.com/repos/${repository}/releases/latest`]: (
        _,
        init,
      ) => {
        expect(init.redirect).toBe("manual");
        expect(init.signal).toBeInstanceOf(AbortSignal);
        return new Response(releaseJson);
      },
    });
    const github = githubClient({ api: undefined, fetch: fetcher });
    expect(await github.latestRelease(repository)).toEqual({
      version: "1.1.0",
      archiveUrl,
      bundleUrl: `${archiveUrl}.sigstore.json`,
    });
    expect(seen).toEqual([
      `https://api.github.com/repos/${repository}/releases/latest`,
    ]);
  });

  const withRelease = (patch: object) =>
    fakeFetch({
      [`https://api.github.com/repos/${repository}/releases/latest`]: () =>
        new Response(JSON.stringify({ ...JSON.parse(releaseJson), ...patch })),
    }).fetcher;

  test.each([
    ["a pre-release", { prerelease: true }],
    ["a draft", { draft: true }],
    ["a pre-release tag", { tag_name: "v1.1.0-beta.1" }],
    ["a tag with build metadata", { tag_name: "v1.1.0+build" }],
    ["a tag without v", { tag_name: "1.1.0" }],
    ["a tag with leading zeros", { tag_name: "v01.1.0" }],
  ])("refuses %s", async (_, patch) => {
    const github = githubClient({ api: undefined, fetch: withRelease(patch) });
    expect(await refusal(github.latestRelease(repository))).toMatch(
      /isn't a full release tagged v/,
    );
  });

  test("refuses a release without the archive", async () => {
    const github = githubClient({
      api: undefined,
      fetch: withRelease({ assets: [] }),
    });
    expect(await refusal(github.latestRelease(repository))).toBe(
      `Release v1.1.0 of ${repository} has no aphelion-plugin.tar.`,
    );
  });

  test("says when a repository has no release", async () => {
    const github = githubClient({
      api: undefined,
      fetch: fakeFetch({}).fetcher,
    });
    expect(await refusal(github.latestRelease(repository))).toBe(
      `${repository} has no full release on GitHub.`,
    );
  });

  test("reports a used-up rate limit with its reset time", async () => {
    const { fetcher } = fakeFetch({
      [`https://api.github.com/repos/${repository}/releases/latest`]: () =>
        new Response("limit", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1800000000",
          },
        }),
    });
    const github = githubClient({ api: undefined, fetch: fetcher });
    expect(await refusal(github.latestRelease(repository))).toBe(
      "GitHub's rate limit for this address is used up until 2027-01-15T08:00:00.000Z, so try again after that.",
    );
  });
});

describe("download", () => {
  const asset =
    "https://release-assets.githubusercontent.com/github-production-release-asset/1/2";

  test("follows GitHub's redirects to the asset host", async () => {
    const { fetcher, seen } = fakeFetch({
      [archiveUrl]: redirect(`${asset}?sig=secret`),
      [asset]: () => new Response("archive bytes"),
    });
    const github = githubClient({ api: undefined, fetch: fetcher });
    expect(
      Buffer.from(await github.download(archiveUrl, "archive")).toString(),
    ).toBe("archive bytes");
    expect(seen).toEqual([archiveUrl, `${asset}?sig=secret`]);
  });

  test.each([
    ["another host", "https://evil.example/asset"],
    ["plain http", "http://release-assets.githubusercontent.com/a"],
    ["another port", "https://release-assets.githubusercontent.com:8443/a"],
    ["credentials", "https://user:pass@release-assets.githubusercontent.com/a"],
  ])("refuses a redirect to %s", async (_, location) => {
    const { fetcher, seen } = fakeFetch({ [archiveUrl]: redirect(location) });
    const github = githubClient({ api: undefined, fetch: fetcher });
    expect(await refusal(github.download(archiveUrl, "archive"))).toMatch(
      /isn't a GitHub address Aphelion downloads from\.$/,
    );
    expect(seen).toEqual([archiveUrl]);
  });

  test("follows 3 redirects but not 4", async () => {
    const hop = (n: number) => `https://github.com/hop/${String(n)}`;
    const routes = (count: number) => ({
      [archiveUrl]: redirect(hop(1)),
      ...Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          hop(index + 1),
          index + 1 === count
            ? () => new Response("ok")
            : redirect(hop(index + 2)),
        ]),
      ),
    });
    const three = githubClient({
      api: undefined,
      fetch: fakeFetch(routes(3)).fetcher,
    });
    expect(
      await refusal(three.download(archiveUrl, "archive")),
    ).toBeUndefined();
    const four = githubClient({
      api: undefined,
      fetch: fakeFetch(routes(4)).fetcher,
    });
    expect(await refusal(four.download(archiveUrl, "archive"))).toBe(
      "The aphelion-plugin.tar redirects more than 3 times.",
    );
  });

  test("stops a download that grows past its limit, and keeps one at the limit", async () => {
    const body = (size: number) => () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(size));
            controller.close();
          },
        }),
      );
    const exact = githubClient({
      api: undefined,
      fetch: fakeFetch({ [archiveUrl]: body(downloadLimits.bundle) }).fetcher,
    });
    expect((await exact.download(archiveUrl, "bundle")).length).toBe(
      downloadLimits.bundle,
    );
    const over = githubClient({
      api: undefined,
      fetch: fakeFetch({ [archiveUrl]: body(downloadLimits.bundle + 1) })
        .fetcher,
    });
    expect(await refusal(over.download(archiveUrl, "bundle"))).toBe(
      "The aphelion-plugin.tar.sigstore.json is larger than 1 MiB, so Aphelion won't download it.",
    );
  });

  test("never shows a redirect's query string", async () => {
    const { fetcher } = fakeFetch({
      [archiveUrl]: redirect(`${asset}?sig=secret`),
      [asset]: () => new Response("gone", { status: 410 }),
    });
    const github = githubClient({ api: undefined, fetch: fetcher });
    const reason = await refusal(github.download(archiveUrl, "archive"));
    expect(reason).toBe(
      "GitHub answered 410 for release-assets.githubusercontent.com/github-production-release-asset/1/2.",
    );
  });
});

describe("APHELION_GITHUB_API", () => {
  test("serves everything from that one origin, plain http included", async () => {
    const local = "http://127.0.0.1:8099";
    const { fetcher, seen } = fakeFetch({
      [`${local}/repos/${repository}/releases/latest`]: () =>
        new Response(releaseJson.replaceAll("https://github.com", local)),
      [`${local}/${repository}/releases/download/v1.1.0/aphelion-plugin.tar`]:
        () => new Response("bytes"),
    });
    const github = githubClient({ api: local, fetch: fetcher });
    const release = await github.latestRelease(repository);
    expect(await github.download(release.archiveUrl, "archive")).toHaveLength(
      5,
    );
    expect(seen.every((url) => url.startsWith(`${local}/`))).toBe(true);
    expect(await refusal(github.download(archiveUrl, "archive"))).toMatch(
      /https:\/\/github.com, which isn't a GitHub address/,
    );
  });

  test("must be a bare origin", () => {
    expect(() => githubClient({ api: "http://127.0.0.1:8099/v3" })).toThrow(
      UpdateRefused,
    );
    expect(() => githubClient({ api: "ftp://127.0.0.1" })).toThrow(
      UpdateRefused,
    );
  });
});
