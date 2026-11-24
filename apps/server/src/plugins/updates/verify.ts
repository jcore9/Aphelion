import { createHash } from "node:crypto";
import { releaseArchiveName } from "@aphelion/plugin-sdk";
import { bundleFromJSON, isBundleWithDsseEnvelope } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import {
  PolicyError,
  VerificationError,
  Verifier,
  toSignedEntity,
  toTrustMaterial,
} from "@sigstore/verify";
import { z } from "zod";
import { UpdateRefused } from "./refused";
import trustedRoot from "./trusted-root.json" with { type: "json" };

const githubActionsIssuer = "https://token.actions.githubusercontent.com";
const githubPrefix = "https://github.com/";

let verifier: Verifier | undefined;

export const releaseIdentity = (repository: string, version: string) =>
  `${githubPrefix}${repository}/.github/workflows/release.yml@refs/tags/v${version}`;

export function identityMatches(
  subjectAlternativeName: string | undefined,
  repository: string,
  version: string,
): boolean {
  const expected = releaseIdentity(repository, version);
  const san = subjectAlternativeName;
  if (san?.length !== expected.length) return false;
  const end = githubPrefix.length + repository.length;
  return (
    san.startsWith(githubPrefix) &&
    san.slice(githubPrefix.length, end).toLowerCase() ===
      repository.toLowerCase() &&
    san.slice(end) === expected.slice(end)
  );
}

const statementSchema = z.object({
  _type: z.literal("https://in-toto.io/Statement/v1"),
  predicateType: z.literal("https://slsa.dev/provenance/v1"),
  subject: z
    .array(
      z.object({
        name: z.string(),
        digest: z.record(z.string(), z.string()),
      }),
    )
    .length(1),
});

export function statementProblem(
  payload: Uint8Array,
  archiveSha256: string,
): string | undefined {
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(payload).toString("utf8"));
  } catch {
    return "holds a statement that isn't JSON";
  }
  const statement = statementSchema.safeParse(data);
  if (!statement.success) {
    return "isn't build provenance for one file";
  }
  const [subject] = statement.data.subject;
  if (subject?.name !== releaseArchiveName) {
    return `vouches for ${JSON.stringify(subject?.name)}, not ${releaseArchiveName}`;
  }
  if (subject.digest["sha256"] !== archiveSha256) {
    return `vouches for other bytes than the downloaded ${releaseArchiveName}`;
  }
  return undefined;
}

const refuse = (reason: string) =>
  new UpdateRefused({
    reason: `The release's attestation ${reason}, so Aphelion won't install it.`,
  });

export function verifyRelease(release: {
  readonly repository: string;
  readonly version: string;
  readonly archive: Uint8Array;
  readonly bundle: Uint8Array;
}): void {
  let bundle;
  try {
    bundle = bundleFromJSON(
      JSON.parse(Buffer.from(release.bundle).toString("utf8")),
    );
  } catch {
    throw refuse("isn't a Sigstore bundle");
  }
  if (!isBundleWithDsseEnvelope(bundle)) {
    throw refuse("holds no signed statement");
  }
  const envelope = bundle.content.dsseEnvelope;
  if (envelope.payloadType !== "application/vnd.in-toto+json") {
    throw refuse("holds no in-toto statement");
  }
  verifier ??= new Verifier(
    toTrustMaterial(TrustedRoot.fromJSON(trustedRoot)),
    { tlogThreshold: 1, ctlogThreshold: 1 },
  );
  let signer;
  try {
    signer = verifier.verify(toSignedEntity(bundle), {
      extensions: { issuer: githubActionsIssuer },
    });
  } catch (error) {
    if (error instanceof VerificationError || error instanceof PolicyError) {
      throw refuse(
        `doesn't check out (${error.code}): the release isn't genuine, or it's signed with a key this Aphelion doesn't know, and upgrading Aphelion fixes that`,
      );
    }
    throw error;
  }
  const identity = signer.identity?.subjectAlternativeName;
  if (!identityMatches(identity, release.repository, release.version)) {
    throw refuse(
      `names ${JSON.stringify(identity ?? "no workflow")}, not the release workflow of ${release.repository} at tag v${release.version}`,
    );
  }
  const sha256 = createHash("sha256").update(release.archive).digest("hex");
  const problem = statementProblem(envelope.payload, sha256);
  if (problem !== undefined) throw refuse(problem);
}
