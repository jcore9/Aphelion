import { z } from "zod";
import { toolVersion, type toolNames } from "./list";
import type { Parsed } from "./vendor-checksums";

export const claudeBase = "https://downloads.claude.ai/claude-code-releases";
export const grokHosts = [
  "https://x.ai/cli",
  "https://storage.googleapis.com/grok-build-public-artifacts/cli",
] as const;

type VendorName = (typeof toolNames)[number];

export type Fetcher = typeof fetch;

export type CheckState = "current" | "newer version available" | "unknown";

export const defaultLookupTimeoutMs = 10_000;
const maxAnswerBytes = 4 * 1024 * 1024;

const fail = (message: string): Parsed<never> => ({ ok: false, message });
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const githubHeaders = {
  accept: "application/vnd.github+json",
  "user-agent": "aphelion-tool-check",
};

function versionFile(text: string): Parsed<string> {
  const found = toolVersion.safeParse(text.trim());
  return found.success
    ? { ok: true, value: found.data }
    : fail("the version file doesn't hold one plain version number");
}

const release = z.object({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
});

function releaseVersion(
  one: z.infer<typeof release>,
  tagPattern: RegExp,
): string | undefined {
  if (one.draft || one.prerelease) return undefined;
  const version = toolVersion.safeParse(tagPattern.exec(one.tag_name)?.[1]);
  return version.success ? version.data : undefined;
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const latestRelease =
  (tagPattern: RegExp) =>
  (text: string): Parsed<string> => {
    const parsed = release.safeParse(parseJson(text));
    if (!parsed.success) return fail("the answer isn't a GitHub release");
    const version = releaseVersion(parsed.data, tagPattern);
    return version === undefined
      ? fail(`the latest release ${parsed.data.tag_name} isn't a plain version`)
      : { ok: true, value: version };
  };

const highestRelease =
  (tagPattern: RegExp) =>
  (text: string): Parsed<string> => {
    const parsed = z.array(release).safeParse(parseJson(text));
    if (!parsed.success) return fail("the answer isn't a list of releases");
    const versions = parsed.data.flatMap((one) => {
      const version = releaseVersion(one, tagPattern);
      return version === undefined ? [] : [version];
    });
    const highest = versions.sort(compareVersions).at(-1);
    return highest === undefined
      ? fail("none of the latest releases is a plain version")
      : { ok: true, value: highest };
  };

interface Source {
  readonly urls: readonly string[];
  readonly headers: Record<string, string>;
  readonly parse: (text: string) => Parsed<string>;
}

function sourceFor(name: VendorName): Source {
  switch (name) {
    case "claude":
      return {
        urls: [`${claudeBase}/latest`],
        headers: {},
        parse: versionFile,
      };
    case "grok":
      return {
        urls: grokHosts.map((host) => `${host}/stable`),
        headers: {},
        parse: versionFile,
      };
    case "codex":
      return {
        urls: ["https://api.github.com/repos/openai/codex/releases/latest"],
        headers: githubHeaders,
        parse: latestRelease(/^rust-v(\d+\.\d+\.\d+)$/),
      };
    case "opencode":
      return {
        urls: [
          "https://api.github.com/repos/anomalyco/opencode/releases?per_page=10",
        ],
        headers: githubHeaders,
        parse: highestRelease(/^v(\d+\.\d+\.\d+)$/),
      };
    default: {
      const _exhaustive: never = name;
      return _exhaustive;
    }
  }
}

class AnswerTooLarge extends Error {}

async function readCapped(response: Response): Promise<string | undefined> {
  if (response.body === null) return "";
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    await response.body.pipeTo(
      new WritableStream<Uint8Array>({
        write(chunk) {
          received += chunk.byteLength;
          if (received > maxAnswerBytes) throw new AnswerTooLarge();
          chunks.push(chunk);
        },
      }),
    );
  } catch (error) {
    if (error instanceof AnswerTooLarge) return undefined;
    throw error;
  }
  const joined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

async function ask(
  url: string,
  source: Source,
  fetcher: Fetcher,
  timeoutMs: number,
): Promise<Parsed<string>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no answer after ${String(timeoutMs)} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async (): Promise<Parsed<string>> => {
        const response = await fetcher(url, {
          signal: controller.signal,
          headers: source.headers,
        });
        if (!response.ok)
          return fail(`${url} answered ${String(response.status)}`);
        const body = await readCapped(response);
        return body === undefined
          ? fail(`${url} answered more than ${String(maxAnswerBytes)} bytes`)
          : source.parse(body);
      })(),
      timedOut,
    ]);
  } catch (error) {
    return fail(`can't reach ${url}: ${errorText(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function lookupLatest(
  name: VendorName,
  fetcher: Fetcher,
  options: { readonly timeoutMs?: number } = {},
): Promise<Parsed<string>> {
  const source = sourceFor(name);
  const timeoutMs = options.timeoutMs ?? defaultLookupTimeoutMs;
  const failures: string[] = [];
  for (const url of source.urls) {
    const found = await ask(url, source, fetcher, timeoutMs);
    if (found.ok) return found;
    failures.push(found.message);
  }
  return fail(failures.join("; "));
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function checkState(pinned: string, latest: Parsed<string>): CheckState {
  if (!latest.ok) return "unknown";
  return compareVersions(latest.value, pinned) > 0
    ? "newer version available"
    : "current";
}
