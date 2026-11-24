import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { UpdateRefused } from "./refused";
import {
  identityMatches,
  releaseIdentity,
  statementProblem,
  verifyRelease,
} from "./verify";

const repository = "jcore9-bot/aphelion-test-plugin";
const fixture = (version: string, file: string) =>
  readFileSync(
    join(
      import.meta.dirname,
      "fixtures/aphelion-test-plugin",
      `v${version}`,
      file,
    ),
  );
const release = (version: string) => ({
  repository,
  version,
  archive: fixture(version, "aphelion-plugin.tar"),
  bundle: fixture(version, "aphelion-plugin.tar.sigstore.json"),
});

const refusal = (input: Parameters<typeof verifyRelease>[0]) => {
  try {
    verifyRelease(input);
  } catch (error) {
    if (error instanceof UpdateRefused) return error.reason;
    throw error;
  }
  return undefined;
};

describe("verifyRelease", () => {
  test.each(["1.0.0", "1.1.0"])("accepts the real release v%s", (version) => {
    expect(refusal(release(version))).toBeUndefined();
  });

  test("accepts the repository in another case", () => {
    expect(
      refusal({
        ...release("1.0.0"),
        repository: "JCore9-Bot/Aphelion-Test-Plugin",
      }),
    ).toBeUndefined();
  });

  test("refuses a release built in another repository", () => {
    expect(
      refusal({
        ...release("1.0.0"),
        repository: "octo-org/aphelion-test-plugin",
      }),
    ).toContain(
      "not the release workflow of octo-org/aphelion-test-plugin at tag v1.0.0",
    );
  });

  test("refuses a release built from another tag", () => {
    expect(refusal({ ...release("1.0.0"), version: "1.1.0" })).toContain(
      "at tag v1.1.0",
    );
  });

  test("refuses an archive with one changed byte", () => {
    const archive = Buffer.from(release("1.1.0").archive);
    archive[1024] = (archive[1024] ?? 0) ^ 1;
    expect(refusal({ ...release("1.1.0"), archive })).toBe(
      "The release's attestation vouches for other bytes than the downloaded aphelion-plugin.tar, so Aphelion won't install it.",
    );
  });

  test("refuses a bundle swapped in from the other version", () => {
    expect(
      refusal({ ...release("1.1.0"), bundle: release("1.0.0").bundle }),
    ).toContain("at tag v1.1.0");
    expect(
      refusal({
        ...release("1.0.0"),
        version: "1.1.0",
        bundle: release("1.1.0").bundle,
      }),
    ).toContain("other bytes");
  });

  test("refuses a bundle whose signed statement was edited", () => {
    const bundle = JSON.parse(release("1.1.0").bundle.toString()) as {
      dsseEnvelope: { payload: string };
    };
    const statement = JSON.parse(
      Buffer.from(bundle.dsseEnvelope.payload, "base64").toString(),
    ) as { subject: { digest: { sha256: string } }[] };
    const tampered = Buffer.from(release("1.1.0").archive);
    tampered[1024] = (tampered[1024] ?? 0) ^ 1;
    const [subject] = statement.subject;
    if (subject === undefined) throw new Error("the fixture has no subject");
    subject.digest.sha256 = createHash("sha256").update(tampered).digest("hex");
    bundle.dsseEnvelope.payload = Buffer.from(
      JSON.stringify(statement),
    ).toString("base64");
    expect(
      refusal({
        ...release("1.1.0"),
        archive: tampered,
        bundle: Buffer.from(JSON.stringify(bundle)),
      }),
    ).toMatch(/doesn't check out \([A-Z_]+\)/);
  });

  test("refuses a file that isn't a bundle", () => {
    expect(
      refusal({ ...release("1.0.0"), bundle: Buffer.from("{}") }),
    ).toContain("isn't a Sigstore bundle");
  });
});

describe("identityMatches", () => {
  const expected = releaseIdentity(repository, "1.2.0");

  test("accepts the release workflow at the tag, with the repository in any case", () => {
    expect(identityMatches(expected, repository, "1.2.0")).toBe(true);
    expect(
      identityMatches(
        expected.replace("jcore9-bot", "JCORE9-BOT"),
        repository,
        "1.2.0",
      ),
    ).toBe(true);
  });

  test.each([
    ["another workflow", expected.replace("release.yml", "ci.yml")],
    ["a branch", expected.replace("refs/tags/v1.2.0", "refs/heads/v1.2.0")],
    ["another tag", expected.replace("v1.2.0", "v1.2.1")],
    ["the tag in another case", expected.replace("v1.2.0", "V1.2.0")],
    [
      "the workflow path in another case",
      expected.replace(".github", ".GitHub"),
    ],
    ["another host", expected.replace("github.com", "gitlab.com")],
    [
      "another repository",
      expected.replace("aphelion-test-plugin", "aphelion-test-plugon"),
    ],
    ["no identity", undefined],
  ])("refuses %s", (_, identity) => {
    expect(identityMatches(identity, repository, "1.2.0")).toBe(false);
  });
});

describe("statementProblem", () => {
  const sha = "a".repeat(64);
  const statement = (patch: object = {}) =>
    Buffer.from(
      JSON.stringify({
        _type: "https://in-toto.io/Statement/v1",
        predicateType: "https://slsa.dev/provenance/v1",
        subject: [{ name: "aphelion-plugin.tar", digest: { sha256: sha } }],
        predicate: {},
        ...patch,
      }),
    );

  test("accepts build provenance for the downloaded archive", () => {
    expect(statementProblem(statement(), sha)).toBeUndefined();
  });

  test.each([
    ["another statement type", { _type: "https://in-toto.io/Statement/v0.1" }],
    ["another predicate", { predicateType: "https://example.com/other" }],
    [
      "two subjects",
      {
        subject: [
          { name: "aphelion-plugin.tar", digest: { sha256: sha } },
          { name: "x", digest: {} },
        ],
      },
    ],
    ["no subject", { subject: [] }],
    [
      "another file name",
      { subject: [{ name: "other.tar", digest: { sha256: sha } }] },
    ],
    [
      "another digest",
      {
        subject: [
          { name: "aphelion-plugin.tar", digest: { sha256: "b".repeat(64) } },
        ],
      },
    ],
    [
      "no sha256 digest",
      { subject: [{ name: "aphelion-plugin.tar", digest: { sha512: sha } }] },
    ],
  ])("refuses %s", (_, patch) => {
    expect(statementProblem(statement(patch), sha)).toBeTypeOf("string");
  });

  test("refuses a payload that isn't JSON", () => {
    expect(statementProblem(Buffer.from("not json"), sha)).toBe(
      "holds a statement that isn't JSON",
    );
  });
});
