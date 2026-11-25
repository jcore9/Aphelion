# 0062. One `main` branch, and the bot merges its own pull requests

- Status: Proposed (owner-path test, not for merging)
- Date: 2026-11-25
- Decided by: project owner
- Proposed by: [#194](https://github.com/jcore9/Aphelion/issues/194)
- Answers: [#194](https://github.com/jcore9/Aphelion/issues/194), which branches the repository keeps from M1 on, and who merges
- Amends: [0003](0003-release-versioning.md) and [0061](0061-release-please.md), which both assume a release pull request from `dev` into `main`. The plan's Development workflow section. [Branch protection](../branch-protection.md).

## Context

Until now the repository has two long-lived branches. Work merges into `dev`, and a release pull request moves `dev` into `main` at the end of each milestone. The owner approves every pull request on both branches.

The owner asked for less of that: "start merging and reviewing your own work completely without having a lot of my input until the end of a milestone." T3 Code, the tool this project borrows its workflow from, has one `main` branch. A maintainer merges every pull request as one commit, and a release is a tag on `main`. [Decision 0061](0061-release-please.md) already planned this move for after `v0.1.0-alpha.1`.

Terms used below:

- A **ruleset** is a set of GitHub rules for a branch or a tag. The repository's rulesets are files in [`.github/rulesets/`](https://github.com/jcore9/Aphelion/tree/main/.github/rulesets).
- A **code owner** is a person named in `.github/CODEOWNERS` for a path. With the right setting on, a pull request that changes that path can't merge until the code owner approves it.
- A **squash merge** turns all the commits of a pull request into one commit on the target branch.
- A **tag** is a name, such as `v0.1.0-alpha.2`, fixed to one commit.
- A **bypass actor** is a person or role that a ruleset doesn't apply to.

## Options

| Option | For | Against |
| --- | --- | --- |
| Keep `dev` and `main` | Nothing changes. | The owner reviews every pull request. Each release needs a merge-commit pull request and extra rules to keep the branches in step. |
| One `main`, and the owner merges every pull request | Simple. Matches T3 Code. | The owner is still the bottleneck for every change. |
| One `main`, and jcore9-bot merges its own pull requests under conditions (chosen) | The owner's time goes to settings, releases, plans and decisions, and to the end-of-milestone review. | The bot's merge rights need clear limits, and GitHub's rules need a workaround: 0 required approvals. |

## Decision

The third option.

- **One branch, squash merges.** `main` is the only long-lived branch. A pull request goes into `main` and is squash-merged. The squash commit takes the pull request's title, which feeds the release notes. `dev` and `hotfix/` branches go.
- **What the bot may merge.** jcore9-bot squash-merges a pull request it opened when all of these hold:
  - Every CI check is green, including the required `lint`, `typecheck` and `test`.
  - A review from another model family is on record, and its findings are fixed or answered.
  - It isn't the release pull request, and it creates no tag.
  - It changes no path that `CODEOWNERS` names, unless the owner has approved it. The bot keeps to this whether or not GitHub enforces it.
- **Code owners.** The `* @jcore9` line of `CODEOWNERS` goes. The owner still approves GitHub settings, CI and workflows, release config, dependencies and build settings, the lint and type rules, the decision records and the plan, `SECURITY.md` and `LICENSE`. Security code (secrets, broker, auth, devices, plugin host, gateway, policy, hooks, adapters, the Dockerfile, Compose files, deploy files and install scripts) is no longer listed. It merges after another model family has reviewed it, and the owner reviews it at the end of the milestone.
- **No approvals, with code owner review on.** `main` requires 0 approving reviews and keeps "require review from code owners", which should make GitHub hold owner paths for the owner. The open risk below says how that gets tested. GitHub never lets the author of a pull request approve it, and the bot authors every pull request, so any higher count would block every bot merge.
- **Release tags.** A tag ruleset on `refs/tags/v*` blocks moving and deleting a tag. Admins may bypass it, so the owner can fix a wrong tag. The ruleset can't restrict creating a tag. We measured it on 2026-11-25 in a throwaway repository. GitHub refuses GitHub Actions as a bypass actor on a personal-account repository (`422 Actor GitHub Actions integration must be part of the ruleset source or owner organization`), and release-please tags with `GITHUB_TOKEN`. A rule that blocked creation would break releases. With only `update` and `deletion` rules, a workflow created a `v9.9.9` tag, and the bot was refused when it tried to move or delete it (`422 Cannot delete this tag`).
- **A release is the release-please pull request.** The owner merges it at the end of the milestone, and the bot never does. release-please then tags `main`.
- **Urgent fixes.** An urgent fix is a normal pull request into `main`. The owner merges the release pull request early to ship it.
- **Installs clone a release tag**, not a branch. [The install guide](../guides/install.md) shows how.

### Open risk

We measured that with 0 approvals and "require review from code owners", the bot squash-merged a pull request whose only code owner was the bot itself. We did not measure a pull request that touches a path owned by someone else, and GitHub's docs don't say whether it blocks at 0 approvals. After the owner applies the rulesets, the bot opens a test pull request that touches an owner path. Once the test is ready for review, has no conflicts, and its three required checks pass on its latest commit, GitHub must still refuse to merge it and must list `@jcore9` as a requested code owner reviewer. The bot reads this with `gh pr view N --json mergeStateStatus,reviewDecision,reviewRequests` and never merges the test. The bot merges no other pull request until this test, and a second test on a path with no code owner, both give the expected result. If GitHub would let the owner-path test merge, the owner sets up the fallback before the bot merges anything: a second GitHub account that posts the cross-family review as a real approval, with 1 approving review required.

## Consequences

- The owner runs the one-time steps in [the rulesets README](https://github.com/jcore9/Aphelion/blob/main/.github/rulesets/README.md): replace the `main` ruleset, add the tag ruleset, delete the `dev` ruleset and the `dev` branch, and set the merge and workflow settings. Until then, nobody merges.
- `Closes #N` in a pull request now closes the issue by itself, because every pull request goes into the default branch.
- The `dev` ruleset, the hotfix flow and the merge-commit rule go. [Branch protection](../branch-protection.md), [the contributing guide](https://github.com/jcore9/Aphelion/blob/main/CONTRIBUTING.md), the plan and the install and release guides change with this record.
- Links to files on `dev` would break when the branch is deleted. This change points the docs, the generated reference pages and the code comments at `main`. A script did the same for the 132 issue bodies that linked to `dev`, on 2026-11-25. Old pull request descriptions and comments keep their `dev` links.
- The owner reviews the bot-merged work at the end of each milestone, before approving the release pull request.
- Revisit if a bot-merged change causes a bad release, or when Aphelion's own manager bots take over the merging.
