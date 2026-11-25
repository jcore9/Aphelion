# 0061. release-please sets the version, the release notes and the tag from commit titles, through a release PR into `main`

- Status: Proposed
- Date: 2026-11-24
- Decided by: project owner
- Proposed by: [#191](https://github.com/jcore9/Aphelion/pull/191)
- Answers: [#192](https://github.com/jcore9/Aphelion/issues/192), which tool works out versions and the changelog from M1 on, and where it runs
- Amends: [0003](0003-release-versioning.md), because the tool makes each tag and GitHub release when the owner merges its release PR, instead of someone tagging by hand. [Branch protection](../branch-protection.md), with a note on the release PR's checks.

## Context

[Decision 0003](0003-release-versioning.md) sets one pre-release tag per milestone, such as `v0.1.0-alpha.2` for M1. For M0 the version was set by hand in #191, and the M0 release notes were written by hand for the `v0.1.0-alpha.1` release. Pull request titles already follow Conventional Commits, a naming rule where the first word says what kind of change it is: `feat:` for a feature, `fix:` for a bug fix, `docs:` for docs, `chore:` for upkeep. A tool can read those titles and do the rest.

After `v0.1.0-alpha.1` ships, the project moves to one branch: pull requests go straight into `main`, and a release is a tag on `main`. A follow-up decision retires `dev` and changes the rulesets and the branch protection docs. This record covers only the release tool.

Terms used below:

- A **tag** is a name, such as `v0.1.0-alpha.2`, fixed to one commit. A **GitHub release** is a page attached to a tag, with notes.
- `GITHUB_TOKEN` is the short-lived key GitHub gives each workflow run. It needs no setup and no stored secret.

## Options

| Option | How it works | For | Against |
| --- | --- | --- | --- |
| release-please (Google) | Keeps one release PR open. Merging it makes the tag and the GitHub release. | The owner approves each release as a PR. Supports pre-release numbers and extra version files. | A PR it opens with `GITHUB_TOKEN` doesn't start CI on its own (see below). |
| semantic-release | Tags and releases on every merge, with no PR. | Fully automatic. | Skips the owner's approval of a release, which the plan requires. |
| Changesets | Each PR adds a small file that says how big the change is. A bot collects them into a release PR. | Clear per-PR control. | One more file to write in every PR, by hand or by a bot. The commit titles already carry the same information. |

## Decision

release-please, run on each push to `main`, with its release PR into `main`, the standard setup for a project with one branch. The files are [`.github/workflows/release.yml`](https://github.com/jcore9/Aphelion/blob/main/.github/workflows/release.yml), [`release-please-config.json`](https://github.com/jcore9/Aphelion/blob/main/release-please-config.json) and [`.release-please-manifest.json`](https://github.com/jcore9/Aphelion/blob/main/.release-please-manifest.json). The action is pinned by commit, as the other actions are.

- **Version files.** The release PR sets the version in `.release-please-manifest.json`, `apps/server/package.json` and `apps/server/src/version.ts`, and writes the release notes in its own description. `bun.lock` is left out, because release-please can't read its format. A stale version there doesn't fail `bun install --frozen-lockfile`, and the next `bun install` corrects it.
- **Pre-release numbers.** The config uses release-please's `prerelease` versioning with type `alpha`. A `feat:`, a `fix:` or a breaking change after `0.1.0-alpha.1` proposes `0.1.0-alpha.2`. The steps in 0003's table that aren't a number increase (M4's `0.1.0`, M5's `1.0.0-beta.1`, M8's `1.0.0`) need a one-time `release-as` override. [The release guide](../guides/releasing.md) gives the steps.
- **Release notes, no `CHANGELOG.md`.** `skip-changelog` is on, so the notes live only in the release PR and then the GitHub release. T3 Code does the same: the [releases page](https://github.com/jcore9/Aphelion/releases) is where people look, and with one copy there is nothing to keep in step. Features, bug fixes, performance, docs and reverts show. Chores, CI, build, tests, refactors and style are hidden.
- **Tags.** When the owner merges the release PR, release-please tags that commit on `main`, for example `v0.1.0-alpha.2`, and creates the GitHub release, marked as a pre-release.
- **First tag.** `v0.1.0-alpha.1` is created by hand once, on `main`'s merge commit for the alpha.1 release, so release-please knows where M1 starts. The workflow first runs on that same merge, before the tag exists, so the owner runs it again once the tag is there.
- **CI on the release PR.** GitHub doesn't start `pull_request` workflows for a PR that `GITHUB_TOKEN` opened or updated, so the required `lint`, `typecheck` and `test` checks don't run on their own. Starting CI from the workflow with `workflow_dispatch` isn't relied on, because those runs may not count toward a ruleset's required checks. At the milestone's end the owner closes and reopens the release PR, which starts CI as the owner, then merges it. No personal access token or new secret is added.
- **Permissions.** The release job may write contents (tags, the release branch) and pull requests, and nothing else.

## Consequences

- The owner sets one repository setting once: Settings → Actions → General → Workflow permissions → **Allow GitHub Actions to create and approve pull requests**. Without it, release-please can't open its PR. The setting also lets a workflow approve a PR, but a code owner's approval is still required to merge, so it doesn't open a way around the owner.
- The owner closes and reopens each release PR once before merging it.
- Revisit if that step becomes a chore, for example with a GitHub App token, or when the desktop and mobile apps need their own version numbers.
