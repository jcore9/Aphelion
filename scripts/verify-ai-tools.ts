import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  buildFor,
  parseToolList,
  processors,
  toolName,
  type Processor,
  type Tool,
  type ToolName,
} from "../apps/server/src/tools/list.ts";
import {
  claudePlatformFor,
  codexAssetFor,
  mismatches,
  opencodeAssetFor,
  parseClaudeManifest,
  parseGithubAsset,
  parseSha256Sums,
  type Expected,
  verifyManifestSignature,
  type GpgRun,
  type Parsed,
} from "../apps/server/src/tools/vendor-checksums.ts";
import {
  claudeBase,
  grokHosts,
} from "../apps/server/src/tools/vendor-latest.ts";

const usage = `usage:
  bun scripts/verify-ai-tools.ts [--download] [--skip-signature] [--list FILE]
      Check every entry of the list against its vendor. With --download, also
      download each build from its listed address and check the file itself.
      Claude's manifest must carry a good gpg signature, so the check fails
      when gpg isn't installed. --skip-signature skips that check and says so.
  bun scripts/verify-ai-tools.ts --print NAME VERSION [--skip-signature]
      Print the "builds" entry for a tool version, taken from the vendor.`;

const claudeKeyUrl = "https://downloads.claude.ai/keys/claude-code.asc";
const claudeKeyFingerprint = "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE";

function checksumSourceOf(name: ToolName): Tool["checksumSource"] {
  switch (name) {
    case "claude":
      return "vendor-manifest";
    case "codex":
      return "github-digest";
    case "opencode":
      return "sha256sums";
    case "grok":
      return "recorded";
    default: {
      const _exhaustive: never = name;
      return _exhaustive;
    }
  }
}

const githubHeaders = (): Record<string, string> => {
  const token = process.env["GITHUB_TOKEN"];
  return token === undefined || token === ""
    ? { accept: "application/vnd.github+json" }
    : {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
      };
};

async function getText(url: string, headers?: Record<string, string>) {
  const response = await fetch(url, headers === undefined ? {} : { headers });
  if (!response.ok)
    throw new Error(`${url} answered ${String(response.status)}`);
  return response.text();
}

const hashes = new Map<string, Promise<{ sha256: string; size: number }>>();

function hashUrl(url: string) {
  const known = hashes.get(url);
  if (known !== undefined) return known;
  const pending = (async () => {
    const response = await fetch(url);
    if (!response.ok || response.body === null) {
      throw new Error(`${url} answered ${String(response.status)}`);
    }
    const hash = createHash("sha256");
    let size = 0;
    await response.body.pipeTo(
      new WritableStream<Uint8Array>({
        write(chunk) {
          hash.update(chunk);
          size += chunk.byteLength;
        },
      }),
    );
    return { sha256: hash.digest("hex"), size };
  })();
  hashes.set(url, pending);
  return pending;
}

const fail = (message: string): Parsed<never> => ({ ok: false, message });

let skipSignature = false;

type ClaudeManifest = {
  readonly text: string;
  readonly signature: Parsed<string> | "skipped";
};

const claudeManifests = new Map<string, Promise<ClaudeManifest>>();

const gpgRunner =
  (home: string): GpgRun =>
  (args) => {
    const ran = spawnSync(
      "gpg",
      ["--homedir", home, "--batch", "--status-fd", "1", ...args],
      { encoding: "utf8" },
    );
    return {
      found: ran.error === undefined,
      status: ran.status,
      stdout: ran.stdout,
    };
  };

async function downloadClaudeManifest(
  version: string,
): Promise<ClaudeManifest> {
  const home = mkdtempSync(join(tmpdir(), "verify-ai-tools-"));
  try {
    const manifest = join(home, "manifest.json");
    writeFileSync(
      manifest,
      await getText(`${claudeBase}/${version}/manifest.json`),
    );
    if (skipSignature) {
      return { text: readFileSync(manifest, "utf8"), signature: "skipped" };
    }
    const sig = await fetch(`${claudeBase}/${version}/manifest.json.sig`);
    if (!sig.ok) {
      return {
        text: "",
        signature: fail(
          `the manifest has no signature (${String(sig.status)})`,
        ),
      };
    }
    const signature = join(home, "manifest.json.sig");
    writeFileSync(signature, new Uint8Array(await sig.arrayBuffer()));
    const key = join(home, "key.asc");
    writeFileSync(key, await getText(claudeKeyUrl));
    return {
      text: readFileSync(manifest, "utf8"),
      signature: verifyManifestSignature(
        gpgRunner(home),
        { key, signature, manifest },
        claudeKeyFingerprint,
      ),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function claudeManifestFor(version: string) {
  const known = claudeManifests.get(version);
  if (known !== undefined) return known;
  const pending = downloadClaudeManifest(version);
  claudeManifests.set(version, pending);
  return pending;
}

async function claudeExpected(
  version: string,
  processor: Processor,
): Promise<Parsed<Expected>> {
  const platform = claudePlatformFor(processor);
  const manifest = await claudeManifestFor(version);
  if (manifest.signature !== "skipped" && !manifest.signature.ok) {
    return manifest.signature;
  }
  const parsed = parseClaudeManifest(manifest.text, version, platform);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: {
      url: `${claudeBase}/${version}/${platform}/claude`,
      ...parsed.value,
      format: "binary",
      entry: "claude",
    },
  };
}

async function codexExpected(
  version: string,
  processor: Processor,
): Promise<Parsed<Expected>> {
  const asset = codexAssetFor(processor);
  const text = await getText(
    `https://api.github.com/repos/openai/codex/releases/tags/rust-v${version}`,
    githubHeaders(),
  );
  const parsed = parseGithubAsset(text, asset);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: {
      ...parsed.value,
      format: "tar.gz",
      entry: asset.replace(/\.tar\.gz$/, ""),
    },
  };
}

async function opencodeExpected(
  version: string,
  processor: Processor,
): Promise<Parsed<Expected>> {
  const asset = opencodeAssetFor(processor);
  const release = parseGithubAsset(
    await getText(
      `https://api.github.com/repos/anomalyco/opencode/releases/tags/v${version}`,
      githubHeaders(),
    ),
    asset,
  );
  if (!release.ok) return release;
  const sums = parseSha256Sums(
    await getText(
      `https://github.com/anomalyco/opencode/releases/download/v${version}/SHA256SUMS`,
    ),
  );
  const listed = sums.get(asset);
  if (listed === undefined) return fail(`SHA256SUMS has no line for ${asset}`);
  if (listed !== release.value.sha256) {
    return fail(
      `SHA256SUMS says ${listed} and GitHub's digest says ${release.value.sha256}`,
    );
  }
  return {
    ok: true,
    value: { ...release.value, format: "tar.gz", entry: "opencode" },
  };
}

async function grokExpected(
  version: string,
  processor: Processor,
): Promise<Parsed<Expected>> {
  const [primary, mirror] = grokHosts.map(
    (host) => `${host}/grok-${version}-linux-${processor}`,
  );
  if (primary === undefined || mirror === undefined) return fail("no host");
  const first = await hashUrl(primary);
  const second = await hashUrl(mirror);
  if (first.sha256 !== second.sha256 || first.size !== second.size) {
    return fail(
      `the two hosts differ: ${first.sha256} (${String(first.size)} bytes) at ${primary}, ${second.sha256} (${String(second.size)} bytes) at ${mirror}`,
    );
  }
  return {
    ok: true,
    value: {
      url: primary,
      sha256: first.sha256 as Expected["sha256"],
      size: first.size,
      format: "binary",
      entry: "grok",
    },
  };
}

function expectedFor(
  name: ToolName,
  version: string,
  processor: Processor,
): Promise<Parsed<Expected>> {
  switch (name) {
    case "claude":
      return claudeExpected(version, processor);
    case "codex":
      return codexExpected(version, processor);
    case "opencode":
      return opencodeExpected(version, processor);
    case "grok":
      return grokExpected(version, processor);
    default: {
      const _exhaustive: never = name;
      return _exhaustive;
    }
  }
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

async function settled<T>(work: () => Promise<Parsed<T>>): Promise<Parsed<T>> {
  try {
    return await work();
  } catch (error) {
    return fail(errorText(error));
  }
}

let failures = 0;
const line = (state: "ok" | "FAIL" | "skip", text: string) => {
  if (state === "FAIL") failures += 1;
  console.log(`${state.padEnd(4)}  ${text}`);
};

const agreement = (tool: Tool) =>
  tool.checksumSource === "recorded"
    ? "both xAI hosts serve the same file"
    : "matches the vendor";

async function checkEntry(tool: Tool, processor: Processor, download: boolean) {
  const label = `${tool.name} ${tool.version} ${processor}`;
  const available = buildFor(tool, processor);
  if (available.kind === "unavailable") {
    line("skip", `${label}: no build on this processor`);
    return;
  }
  if (tool.checksumSource !== checksumSourceOf(tool.name)) {
    line(
      "FAIL",
      `${label}: checksumSource is ${tool.checksumSource}, but ${tool.name} is checked by ${checksumSourceOf(tool.name)}`,
    );
    return;
  }
  const expected = await settled(() =>
    expectedFor(tool.name, tool.version, processor),
  );
  if (!expected.ok) {
    line("FAIL", `${label}: ${expected.message}`);
    return;
  }
  const wrong = mismatches(available.build, expected.value);
  if (wrong.length > 0) {
    line("FAIL", `${label}: ${wrong.join("; ")}`);
    return;
  }
  if (!download) {
    line("ok", `${label}: ${agreement(tool)} (${available.build.sha256})`);
    return;
  }
  const file = await settled(async () => ({
    ok: true as const,
    value: await hashUrl(available.build.url),
  }));
  if (!file.ok) {
    line("FAIL", `${label}: ${file.message}`);
  } else if (
    file.value.sha256 !== available.build.sha256 ||
    file.value.size !== available.build.size
  ) {
    line(
      "FAIL",
      `${label}: the download is ${file.value.sha256} (${String(file.value.size)} bytes), the list says ${available.build.sha256} (${String(available.build.size)} bytes)`,
    );
  } else {
    line(
      "ok",
      `${label}: ${agreement(tool)}, and the download from ${available.build.url} hashes to ${available.build.sha256} (${String(available.build.size)} bytes)`,
    );
  }
}

async function checkList(file: string, download: boolean) {
  const parsed = parseToolList(readFileSync(file, "utf8"));
  if (!parsed.ok) {
    console.error(`verify-ai-tools: ${parsed.message}`);
    return 1;
  }
  for (const tool of parsed.list.tools) {
    if (tool.name === "claude") {
      const manifest = await settled(async () => ({
        ok: true as const,
        value: await claudeManifestFor(tool.version),
      }));
      const label = `claude ${tool.version} manifest`;
      if (!manifest.ok) {
        line("FAIL", `${label}: ${manifest.message}`);
      } else if (manifest.value.signature === "skipped") {
        line(
          "skip",
          `${label}: --skip-signature, so its signature wasn't checked`,
        );
      } else if (manifest.value.signature.ok) {
        line("ok", `${label}: signed by key ${manifest.value.signature.value}`);
      } else {
        line("FAIL", `${label}: ${manifest.value.signature.message}`);
      }
    }
    for (const processor of processors) {
      await checkEntry(tool, processor, download);
    }
  }
  console.log(
    failures === 0 ? "all entries match" : `${String(failures)} failed`,
  );
  return failures === 0 ? 0 : 1;
}

async function print(name: string, version: string) {
  const known = toolName.safeParse(name);
  if (!known.success || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) {
    console.error(usage);
    return 2;
  }
  const builds: Record<string, Expected> = {};
  for (const processor of processors) {
    const expected = await settled(() =>
      expectedFor(known.data, version, processor),
    );
    if (!expected.ok) {
      console.error(
        `${known.data} ${version} ${processor}: ${expected.message}`,
      );
      return 1;
    }
    builds[processor] = expected.value;
  }
  console.log(JSON.stringify(builds, null, 2));
  return 0;
}

let command;
try {
  command = parseArgs({
    options: {
      download: { type: "boolean" },
      list: { type: "string" },
      print: { type: "boolean" },
      "skip-signature": { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
} catch {
  console.error(usage);
  process.exit(2);
}
const { values, positionals } = command;
skipSignature = values["skip-signature"] === true;

if (values.print === true) {
  const [name = "", version = ""] = positionals;
  process.exit(
    positionals.length === 2 && values.download === undefined
      ? await print(name, version)
      : (console.error(usage), 2),
  );
}
if (positionals.length > 0) {
  console.error(usage);
  process.exit(2);
}
process.exit(
  await checkList(
    values.list ?? "deploy/ai-tools.json",
    values.download === true,
  ),
);
