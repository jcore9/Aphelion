import { releaseArchiveName, releaseBundleName } from "@aphelion/plugin-sdk";
import { z } from "zod";
import { UpdateRefused } from "./refused";

export interface Release {
  readonly version: string;
  readonly archiveUrl: string;
  readonly bundleUrl: string;
}

const mebibyte = 1024 * 1024;
export const downloadLimits = {
  releaseJson: mebibyte,
  bundle: mebibyte,
  archive: 32 * mebibyte,
};

const githubHosts = new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const maxRedirects = 3;
const timeoutMs = 30_000;

const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(
    z.object({
      name: z.string(),
      browser_download_url: z.string(),
      size: z.number(),
    }),
  ),
});

const fullReleaseTag =
  /^v((?:0|[1-9]\d{0,14})\.(?:0|[1-9]\d{0,14})\.(?:0|[1-9]\d{0,14}))$/;

const refuse = (reason: string) => new UpdateRefused({ reason });

const shown = (url: URL) => `${url.host}${url.pathname}`;

function apiOrigin(override: string | undefined): URL {
  if (override === undefined) return new URL("https://api.github.com");
  let url: URL | undefined;
  try {
    url = new URL(override);
  } catch {
    url = undefined;
  }
  if (
    url === undefined ||
    !["http:", "https:"].includes(url.protocol) ||
    url.origin + "/" !== url.href
  ) {
    throw refuse(
      "APHELION_GITHUB_API must be a bare origin, such as http://127.0.0.1:8099.",
    );
  }
  return url;
}

export function githubClient(options: {
  readonly api: string | undefined;
  readonly fetch?: typeof fetch;
}) {
  const fetcher = options.fetch ?? fetch;
  const api = apiOrigin(options.api);
  const allowed = (url: URL) =>
    url.username === "" &&
    url.password === "" &&
    (options.api === undefined
      ? url.protocol === "https:" &&
        url.port === "" &&
        githubHosts.has(url.hostname)
      : url.origin === api.origin);

  async function readLimited(response: Response, limit: number, what: string) {
    const tooBig = refuse(
      `The ${what} is larger than ${String(limit / mebibyte)} MiB, so Aphelion won't download it.`,
    );
    if (Number(response.headers.get("content-length") ?? 0) > limit) {
      await response.body?.cancel();
      throw tooBig;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body === null) return new Uint8Array();
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw tooBig;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  async function get(
    start: string,
    request: {
      readonly what: string;
      readonly limit: number;
      readonly accept: string;
      readonly notFound?: string;
    },
  ): Promise<Uint8Array> {
    let url = new URL(start);
    for (let hop = 0; ; hop++) {
      if (!allowed(url)) {
        throw refuse(
          `The ${request.what} is served from ${url.protocol}//${url.host}, which isn't a GitHub address Aphelion downloads from.`,
        );
      }
      let response: Response;
      try {
        response = await fetcher(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            accept: request.accept,
            "user-agent": "aphelion",
            "x-github-api-version": "2022-11-28",
          },
        });
      } catch (error) {
        throw refuse(
          (error as Error).name === "TimeoutError"
            ? `${shown(url)} didn't answer within 30 seconds.`
            : `Can't reach ${url.host}: ${(error as Error).message}.`,
        );
      }
      const location = response.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        await response.body?.cancel();
        if (hop === maxRedirects) {
          throw refuse(`The ${request.what} redirects more than 3 times.`);
        }
        url = new URL(location, url);
        continue;
      }
      if (response.status === 200) {
        return await readLimited(response, request.limit, request.what);
      }
      await response.body?.cancel();
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      if (
        (response.status === 429 ||
          (response.status === 403 &&
            response.headers.get("x-ratelimit-remaining") === "0")) &&
        reset > 0
      ) {
        throw refuse(
          `GitHub's rate limit for this address is used up until ${new Date(reset * 1000).toISOString()}, so try again after that.`,
        );
      }
      if (response.status === 404 && request.notFound !== undefined) {
        throw refuse(request.notFound);
      }
      throw refuse(
        `GitHub answered ${String(response.status)} for ${shown(url)}.`,
      );
    }
  }

  return {
    async latestRelease(repository: string): Promise<Release> {
      const url = new URL(`/repos/${repository}/releases/latest`, api);
      const bytes = await get(url.href, {
        what: "release list",
        limit: downloadLimits.releaseJson,
        accept: "application/vnd.github+json",
        notFound: `${repository} has no full release on GitHub.`,
      });
      let data: unknown;
      try {
        data = JSON.parse(Buffer.from(bytes).toString("utf8"));
      } catch {
        data = undefined;
      }
      const release = releaseSchema.safeParse(data);
      if (!release.success) {
        throw refuse(`GitHub's answer for ${repository} isn't a release.`);
      }
      const { tag_name: tag, draft, prerelease, assets } = release.data;
      const version = fullReleaseTag.exec(tag)?.[1];
      if (version === undefined || draft || prerelease) {
        throw refuse(
          `The latest release of ${repository}, ${JSON.stringify(tag)}, isn't a full release tagged v and a version such as v1.2.0.`,
        );
      }
      const asset = (name: string) => {
        const found = assets.find((candidate) => candidate.name === name);
        if (found === undefined) {
          throw refuse(`Release ${tag} of ${repository} has no ${name}.`);
        }
        return found.browser_download_url;
      };
      return {
        version,
        archiveUrl: asset(releaseArchiveName),
        bundleUrl: asset(releaseBundleName),
      };
    },
    download: (url: string, kind: "archive" | "bundle") =>
      get(url, {
        what: kind === "archive" ? releaseArchiveName : releaseBundleName,
        limit: downloadLimits[kind],
        accept: "application/octet-stream",
      }),
  };
}

export type GithubClient = ReturnType<typeof githubClient>;
