# Branch protection

Changes reach `dev` and `main` only through approved pull requests. The bot account `jcore9-bot` has the Write role ([decision 0005](decisions/0005-bot-account-authors-prs.md)). Without these rules, the Write role lets it push to either branch directly. With them, the owner's approval is the only way in, and that includes the owner's own changes.

Two kinds of file hold the rules:

- [`.github/rulesets/dev.json`](https://github.com/jcore9/Aphelion/blob/dev/.github/rulesets/dev.json) and [`.github/rulesets/main.json`](https://github.com/jcore9/Aphelion/blob/dev/.github/rulesets/main.json) are GitHub repository rulesets. The bot can't change repository settings, so the owner applies them. [The rulesets README](https://github.com/jcore9/Aphelion/blob/dev/.github/rulesets/README.md) gives the steps.
- [`.github/CODEOWNERS`](https://github.com/jcore9/Aphelion/blob/dev/.github/CODEOWNERS) names the owner, `@jcore9`, as the reviewer for each path.

## How a change reaches `dev`

1. The bot pushes a branch for one issue and opens a pull request into `dev`.
2. CI runs `lint`, `typecheck` and `test` from [`.github/workflows/ci.yml`](https://github.com/jcore9/Aphelion/blob/dev/.github/workflows/ci.yml). All three must pass.
3. The owner approves the pull request.
4. The pull request is squash-merged. The squash commit takes the pull request's Conventional Commit title, which feeds the changelog.

## How a change reaches `main`

At the end of a milestone, a release pull request goes from `dev` into `main`. It needs the same checks and the owner's approval. It merges with a merge commit, and `main` gets the milestone's tag from [decision 0003](decisions/0003-release-versioning.md). A hotfix pull request from a `hotfix/` branch goes into `main` the same way.

The bot opens release pull requests too. GitHub doesn't let the author of a pull request approve it, so a release pull request that the owner opens can't merge.

After a hotfix merges into `main`, the bot opens a second pull request from the same `hotfix/` branch into `dev`. A pull request from `main` into `dev` would have the owner as its last pusher, so the owner's approval wouldn't count on `dev`.

## The rules

| Rule | `dev` | `main` |
| --- | --- | --- |
| Changes only through a pull request. Direct pushes are blocked. | Yes | Yes |
| Force pushes and deletion are blocked. | Yes | Yes |
| Approving reviews required | 1 | 1 |
| A code owner must approve. | Yes | Yes |
| A new push dismisses earlier approvals. | Yes | Yes |
| Someone other than the last pusher must approve the last push. | Yes | No |
| Required checks, reported by GitHub Actions | `lint`, `typecheck`, `test` | `lint`, `typecheck`, `test` |
| The branch must be up to date with its base. | No | No |
| Merge method | Squash | Merge commit |
| Bypass actors | None | None |

Nobody can bypass the rules, including the owner. In an emergency, the owner can set a ruleset's enforcement to **Disabled**, which leaves a record in the ruleset's history.

### Why `main` takes merge commits

A merge commit keeps the commits from `dev` as they are, so `main` stays an ancestor of `dev`. The next release pull request then shows only the commits since the last release. A squash or a rebase writes new commits onto `main` that `dev` doesn't have. `dev` accepts only squash merges, so those commits can't be merged back into `dev` with their history. Every later release pull request would then list old commits again.

### Why `main` doesn't require approval of the last push

On a release pull request, the head branch is `dev`. Each merge into `dev` is a push by the person who merged it, and that person is usually the owner. If `main` required someone other than the last pusher to approve, the owner's approval would never count on a release pull request.

The rule isn't needed on `main` to stop the bot. The bot can't push to `dev`, and a push to a hotfix branch after approval still dismisses the approval.

### Why the checks must come from GitHub Actions

Anyone with the Write role can set a commit status with any name through the API. Each required check names GitHub Actions (app ID `15368`) as its source, so a status named `lint` from any other source doesn't count.

The `docs` check from M0-16 isn't required yet. Requiring a check that never runs would block every pull request. M0-16 adds it to both rulesets.

### Why branches don't have to be up to date

Bringing a branch up to date is a new push, so it dismisses the approval. With several pull requests open at once, each merge into `dev` would cost every other pull request a new push and a new approval. CI also runs on each push to `dev`, so a break between two merged pull requests shows on `dev` straight away.

When a pull request into `dev` does need the latest `dev`, the bot updates the branch. If the owner clicks **Update branch**, the owner becomes the last pusher, and the owner's approval no longer counts on that pull request.

## Code owners

The first line of `CODEOWNERS`, `* @jcore9`, makes the owner the code owner of every path. A bot's approval therefore never merges a pull request on its own, even one from a fork. The plan's rollout lets manager bots approve docs-only and test-only pull requests into `dev` later. That step removes the `*` line. The lines below it then keep the security-sensitive paths with the owner.

Some of those paths exist today:

- `CODEOWNERS`, the rulesets, and the workflows
- every `package.json`, `bun.lock` and `bunfig.toml`, because they set the scripts that CI runs, the dependencies, and the package registry
- `eslint.config.ts`, `lint-boundaries.test.ts`, `vitest.config.ts` and every `tsconfig*.json`, which enforce the boundaries in [decision 0023](decisions/0023-scaffold-toolchain.md)
- the Bun-only adapter folders, `packages/server/src/adapters/` and `packages/cli/src/adapters/`, which decision 0023 names before they hold any file
- the decision records, the plan, `SECURITY.md` and `LICENSE`

The other paths are guesses at where future code will live. Most match a folder name in any package, so the code is covered wherever it lands:

| Pattern | For |
| --- | --- |
| `secrets/`, `broker/` | The secrets broker (M0-14) and the secret backends (M0-15) |
| `plugin-host/`, `grants/`, `/packages/plugin-sdk/src/manifest*` | The plugin host, permission grants, and the manifest schema (M0-13) |
| `auth/`, `devices/` | Device tokens (M0-10) and later sign-in |
| `policy/`, `/packages/server/**/hooks/` | The policy engine and its hooks (M2) |
| `gateway/` | The gateway |
| `Dockerfile*`, `/.dockerignore`, `compose*.yaml`, `docker-compose*.yml` and similar | The image and the Compose file (M0-12) |
| `*.service`, `install*.sh`, `/deploy/` | The host unit and the install script (M0-12) |
| `managed-settings.json`, `requirements.toml` | The managed settings for the Claude Code, Grok and Codex CLIs (M0-12, M2-05) |

The `hooks/` pattern is limited to `packages/server`, because React code in `packages/client` often has a `hooks/` folder. The PR that creates one of these paths checks that a pattern covers it, and fixes `CODEOWNERS` if not.

## What the rules don't stop

- A user with the Write role can merge a pull request once it has the approvals and checks it needs. The bot can merge a pull request that the owner approved.
- A workflow changed on a branch runs on that branch's pull request before anyone reviews it. Code owners control what merges, not what runs. Same-repository pull requests get the repository's Actions secrets, so secrets belong in an environment with required reviewers.
- Tags aren't protected. The bot can push a tag such as `v0.1.0`.
