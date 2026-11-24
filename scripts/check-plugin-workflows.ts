import { deepStrictEqual, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  pluginManifestFile,
  releaseArchiveName,
  releaseBundleName,
} from "../packages/plugin-sdk/src/index.ts";

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
};

type Job = { permissions?: unknown; steps: Step[] };

type Workflow = {
  on: unknown;
  permissions: unknown;
  jobs: Record<string, Job>;
};

const project = process.argv[2];
if (project === undefined) {
  console.error("usage: bun scripts/check-plugin-workflows.ts <plugin folder>");
  process.exit(1);
}

const root = resolve(import.meta.dirname, "..");
const archive = `release/${releaseArchiveName}`;
const bundle = `release/${releaseBundleName}`;
const pinned = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const pinnedLine = /^\s*(- )?uses: [^@\s]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;

const read = (path: string) => readFileSync(path, "utf8");

function parse(path: string): { text: string; workflow: Workflow } {
  const text = read(path);
  // eslint-disable-next-line no-restricted-globals -- this script runs under Bun, whose YAML parser saves a dependency
  return { text, workflow: Bun.YAML.parse(text) as Workflow };
}

function onlyJob(workflow: Workflow, file: string): Job {
  const jobs = Object.values(workflow.jobs);
  const [job] = jobs;
  ok(jobs.length === 1 && job, `${file} has exactly one job`);
  return job;
}

const action = (uses: string) => uses.split("@")[0] ?? uses;

const label = (step: Step) =>
  step.name ?? (step.uses === undefined ? step.run : action(step.uses));

function stepNamed(job: Job, name: string): Step {
  const step = job.steps.find((candidate) => candidate.name === name);
  ok(step, `release.yml has a step named "${name}"`);
  return step;
}

const aphelionPins = new Map(
  Object.values(parse(join(root, ".github/workflows/ci.yml")).workflow.jobs)
    .flatMap((job) => job.steps)
    .flatMap((step) => (step.uses === undefined ? [] : [step.uses]))
    .map((uses) => [action(uses), uses]),
);

const bunVersion = (
  JSON.parse(read(join(root, "package.json"))) as { packageManager: string }
).packageManager.replace(/^bun@/, "");

function checkCommon(file: string, text: string, job: Job) {
  for (const step of job.steps) {
    if (step.uses !== undefined) {
      ok(pinned.test(step.uses), `${file}: ${step.uses} is pinned to a SHA`);
      const ours = aphelionPins.get(action(step.uses));
      ok(
        ours === undefined || ours === step.uses,
        `${file}: ${step.uses} uses the same SHA as Aphelion's CI, ${String(ours)}`,
      );
    }
    ok(
      !step.run?.includes("${{"),
      `${file}: step "${String(label(step))}" passes expressions through env, not in its script`,
    );
  }
  for (const line of text.split("\n").filter((l) => /^\s*(- )?uses:/.test(l))) {
    ok(
      pinnedLine.test(line),
      `${file}: "${line.trim()}" has a # vX.Y.Z comment`,
    );
  }
  const setupBun = job.steps.find(
    (step) => step.uses && action(step.uses) === "oven-sh/setup-bun",
  );
  deepStrictEqual(
    setupBun?.with,
    { "bun-version": bunVersion },
    `${file} sets up Bun ${bunVersion}, the version Aphelion uses`,
  );
}

const workflows = join(project, ".github/workflows");

const ci = parse(join(workflows, "ci.yml"));
deepStrictEqual(ci.workflow.on, { push: null, pull_request: null });
deepStrictEqual(ci.workflow.permissions, { contents: "read" });
const check = onlyJob(ci.workflow, "ci.yml");
checkCommon("ci.yml", ci.text, check);
deepStrictEqual(check.steps.map(label), [
  "actions/checkout",
  "oven-sh/setup-bun",
  "bun install --frozen-lockfile",
  "bun run typecheck",
  "bun run test",
  "bun run build",
]);

const release = parse(join(workflows, "release.yml"));
deepStrictEqual(release.workflow.on, { push: { tags: ["v*"] } });
deepStrictEqual(release.workflow.permissions, {});
const publish = onlyJob(release.workflow, "release.yml");
deepStrictEqual(publish.permissions, {
  contents: "write",
  "id-token": "write",
  attestations: "write",
});
checkCommon("release.yml", release.text, publish);
deepStrictEqual(publish.steps.map(label), [
  "Check out the code",
  "Set up Bun",
  "Install the packages",
  "Check the tag matches the manifest",
  "Typecheck",
  "Test",
  "Build",
  "Package",
  "Attest the build provenance",
  "Copy the attestation bundle",
  "Create the release",
]);
deepStrictEqual(
  publish.steps.slice(2).map((step) => step.run?.split("\n")[0]),
  [
    "bun install --frozen-lockfile",
    "version=$(bun --print 'require(\"./aphelion-plugin.json\").version')",
    "bun run typecheck",
    "bun run test",
    "bun run build",
    "bun run package",
    undefined,
    `cp "$BUNDLE" ${bundle}`,
    "version=${GITHUB_REF_NAME#v}",
  ],
);

const attest = stepNamed(publish, "Attest the build provenance");
ok(attest.uses && action(attest.uses) === "actions/attest-build-provenance");
deepStrictEqual(attest.with, { "subject-path": archive });
deepStrictEqual(stepNamed(publish, "Copy the attestation bundle").env, {
  BUNDLE: `\${{ steps.${String(attest.id)}.outputs.bundle-path }}`,
});
const create = stepNamed(publish, "Create the release");
deepStrictEqual(create.env, { GH_TOKEN: "${{ github.token }}" });
ok(
  create.run?.includes(
    `gh release create "$GITHUB_REF_NAME" ${archive} ${bundle} --verify-tag --generate-notes`,
  ),
  "the release step uploads the archive and its bundle",
);

const packageScript = (
  JSON.parse(read(join(project, "package.json"))) as {
    scripts: Record<string, string>;
  }
).scripts["package"];
ok(
  packageScript?.includes(`--format=ustar`) &&
    packageScript.includes(`-cf ${archive} -C dist .`),
  `the package script writes ${archive} as ustar from dist/`,
);

const tagCheck = stepNamed(publish, "Check the tag matches the manifest").run;
const { version } = JSON.parse(read(join(project, pluginManifestFile))) as {
  version: string;
};
ok(tagCheck, "the tag check has a shell script");
const tagFixture = mkdtempSync(join(tmpdir(), "aphelion-release-tag-"));
try {
  const runTagCheck = (manifestVersion: string, tag: string) => {
    writeFileSync(
      join(tagFixture, pluginManifestFile),
      JSON.stringify({ version: manifestVersion }),
    );
    return spawnSync("bash", ["-e", "-c", tagCheck], {
      cwd: tagFixture,
      env: { ...process.env, GITHUB_REF_NAME: tag },
      encoding: "utf8",
    });
  };

  for (const allowed of [version, `${version}-rc.1`]) {
    deepStrictEqual(
      runTagCheck(allowed, `v${allowed}`).status,
      0,
      `the matching tag v${allowed} passes`,
    );
  }
  const wrongTag = runTagCheck(version, `v${version}9`);
  ok(
    wrongTag.status === 1 && wrongTag.stdout.includes("doesn't match version"),
    "a tag that doesn't match the manifest stops the release",
  );
  const buildTag = runTagCheck(`${version}+build`, `v${version}+build`);
  ok(
    buildTag.status === 1 && buildTag.stdout.includes("build metadata"),
    "build metadata stops the release even when the tag matches the manifest",
  );
} finally {
  rmSync(tagFixture, { recursive: true, force: true });
}

console.log("ci.yml and release.yml match the release contract");
