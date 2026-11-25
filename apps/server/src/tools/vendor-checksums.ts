import { z } from "zod";
import { sha256, type Build, type Processor, type Sha256 } from "./list";

export interface Expected {
  readonly url: string;
  readonly sha256: Sha256;
  readonly size: number;
  readonly format: Build["format"];
  readonly entry: string;
}

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

const claudePlatform = z.object({
  checksum: sha256,
  size: z.number().int().positive(),
});

const claudeManifest = z.object({
  version: z.string(),
  platforms: z.record(z.string(), z.unknown()),
});

export function parseClaudeManifest(
  text: string,
  version: string,
  platform: string,
): Parsed<{ readonly sha256: Sha256; readonly size: number }> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, message: "the manifest isn't valid JSON" };
  }
  const manifest = claudeManifest.safeParse(json);
  if (!manifest.success) {
    return { ok: false, message: "the manifest has no version and platforms" };
  }
  if (manifest.data.version !== version) {
    return {
      ok: false,
      message: `the manifest is for ${manifest.data.version}, not ${version}`,
    };
  }
  const found = claudePlatform.safeParse(manifest.data.platforms[platform]);
  if (!found.success) {
    return {
      ok: false,
      message: `the manifest has no usable ${platform} entry`,
    };
  }
  return {
    ok: true,
    value: { sha256: found.data.checksum, size: found.data.size },
  };
}

export function parseSha256Sums(text: string): ReadonlyMap<string, Sha256> {
  const sums = new Map<string, Sha256>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line.trim());
    const digest = sha256.safeParse(match?.[1]);
    const name = match?.[2];
    if (digest.success && name !== undefined) sums.set(name, digest.data);
  }
  return sums;
}

const githubRelease = z.object({
  assets: z.array(
    z.object({
      name: z.string(),
      size: z.number().int().positive(),
      digest: z.string().nullable(),
      browser_download_url: z.string(),
    }),
  ),
});

export function parseGithubAsset(
  text: string,
  assetName: string,
): Parsed<{
  readonly url: string;
  readonly sha256: Sha256;
  readonly size: number;
}> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, message: "the release isn't valid JSON" };
  }
  const release = githubRelease.safeParse(json);
  if (!release.success) {
    return { ok: false, message: "the release has no list of assets" };
  }
  const asset = release.data.assets.find(({ name }) => name === assetName);
  if (asset === undefined) {
    return { ok: false, message: `the release has no asset ${assetName}` };
  }
  const digest = sha256.safeParse(asset.digest?.replace(/^sha256:/, ""));
  if (!digest.success) {
    return { ok: false, message: `${assetName} has no SHA-256 digest` };
  }
  return {
    ok: true,
    value: {
      url: asset.browser_download_url,
      sha256: digest.data,
      size: asset.size,
    },
  };
}

export function mismatches(listed: Build, expected: Expected): string[] {
  const found: string[] = [];
  if (listed.url !== expected.url) {
    found.push(`url is ${listed.url}, the vendor's is ${expected.url}`);
  }
  if (listed.sha256 !== expected.sha256) {
    found.push(
      `sha256 is ${listed.sha256}, the vendor's is ${expected.sha256}`,
    );
  }
  if (listed.size !== expected.size) {
    found.push(
      `size is ${String(listed.size)}, the vendor's is ${String(expected.size)}`,
    );
  }
  if (listed.format !== expected.format) {
    found.push(
      `format is ${listed.format}, the vendor's is ${expected.format}`,
    );
  }
  if (listed.entry !== expected.entry) {
    found.push(`entry is ${listed.entry}, the vendor's is ${expected.entry}`);
  }
  return found;
}

export const claudePlatformFor = (processor: Processor) =>
  processor === "x86_64" ? "linux-x64" : "linux-arm64";

export const opencodeAssetFor = (processor: Processor) =>
  processor === "x86_64"
    ? "opencode-linux-x64.tar.gz"
    : "opencode-linux-arm64.tar.gz";

export const codexAssetFor = (processor: Processor) =>
  `codex-${processor}-unknown-linux-musl.tar.gz`;
