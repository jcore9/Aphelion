import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const source =
  "https://raw.githubusercontent.com/sigstore/root-signing/main/targets/trusted_root.json";
const target = join(
  import.meta.dirname,
  "../apps/server/src/plugins/updates/trusted-root.json",
);

interface Log {
  baseUrl: string;
  logId: { keyId: string };
}
interface Authority {
  uri: string;
  certChain: { certificates: { rawBytes: string }[] };
}
interface TrustedRoot {
  mediaType: string;
  tlogs: Log[];
  ctlogs: Log[];
  certificateAuthorities: Authority[];
  timestampAuthorities?: Authority[];
}

const certificate = (authority: Authority) =>
  createHash("sha256")
    .update(authority.certChain.certificates[0]?.rawBytes ?? "")
    .digest("hex")
    .slice(0, 16);

const keys = (root: TrustedRoot) =>
  new Set([
    ...root.tlogs.map((log) => `tlog ${log.baseUrl} ${log.logId.keyId}`),
    ...root.ctlogs.map((log) => `ctlog ${log.baseUrl} ${log.logId.keyId}`),
    ...root.certificateAuthorities.map(
      (ca) => `ca ${ca.uri} ${certificate(ca)}`,
    ),
    ...(root.timestampAuthorities ?? []).map(
      (tsa) => `tsa ${tsa.uri} ${certificate(tsa)}`,
    ),
  ]);

const response = await fetch(source);
if (!response.ok) {
  console.error(`${source} answered ${String(response.status)}`);
  process.exit(1);
}
const text = await response.text();
const next = JSON.parse(text) as TrustedRoot;
if (!next.mediaType.startsWith("application/vnd.dev.sigstore.trustedroot")) {
  console.error(`${source} isn't a Sigstore trusted root`);
  process.exit(1);
}
const before = keys(JSON.parse(readFileSync(target, "utf8")) as TrustedRoot);
const after = keys(next);
const added = [...after].filter((key) => !before.has(key));
const removed = [...before].filter((key) => !after.has(key));
for (const key of added) console.log(`added   ${key}`);
for (const key of removed) console.log(`removed ${key}`);
writeFileSync(target, text);
console.log(
  `Wrote ${target}: ${String(added.length)} keys added, ${String(removed.length)} removed, sha256 ${createHash("sha256").update(text).digest("hex")}.`,
);
