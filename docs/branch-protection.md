# Branch protection

Aphelion has one long-lived branch, `main`. Changes reach it only through pull requests. The bot account `jcore9-bot` has the Write role ([decision 0005](decisions/0005-bot-account-authors-prs.md)). Without these rules, the Write role lets it push to `main` directly. With them, a pull request is the only way in. The bot squash-merges its own pull requests only under the conditions below ([decision 0062](decisions/0062-one-main-branch.md)).

Two kinds of file hold the rules:

- [`.github/rulesets/main.json`](https://github.com/jcore9/Aphelion/blob/main/.github/rulesets/main.json) and [`.github/rulesets/tags.json`](https://github.com/jcore9/Aphelion/blob/main/.github/rulesets/tags.json) are GitHub repository rulesets, which are sets of rules for a branch or a tag. The bot can't change repository settings, so the owner applies the rulesets. [The rulesets README](https://github.com/jcore9/Aphelion/blob/main/.github/rulesets/README.md) gives the steps.
- [`.github/CODEOWNERS`](https://github.com/jcore9/Aphelion/blob/main/.github/CODEOWNERS) names the owner, `@jcore9`, as the code owner of the paths the owner always decides. A code owner is the person GitHub asks to approve a pull request that changes those paths.

## How a change reaches `main`

1. The bot pushes a branch for one issue and opens a pull request into `main`.
2. CI runs `lint`, `typecheck`, `test`, `docs` and `container` from [`.github/workflows/ci.yml`](https://github.com/jcore9/Aphelion/blob/main/.github/workflows/ci.yml). All five must pass. `docs` builds the docs site and checks its links. `container` builds the Docker image and runs its contract tests.
3. A model from a different family than the author reviews the pull request, and the review is on record. The bot fixes or answers each finding.
4. The bot squash-merges the pull request. A squash merge turns the pull request's commits into one commit. The new commit takes the pull request's Conventional Commit title, and the release notes use that title.
5. If the pull request changes a path that `CODEOWNERS` names, the bot waits for the owner's approval before it merges. GitHub also holds the pull request until then. The test below showed this.

The owner reviews all other merged work at the end of each milestone, before the release.

## The release pull request and the tags

From M1 on, release-please keeps one release pull request open into `main` ([decision 0061](decisions/0061-release-please.md), steps in [the release guide](guides/releasing.md)). It sets the version and writes the release notes. The owner approves and merges it at the end of the milestone. The bot never merges it. Merging it makes a tag, such as `v0.1.0-alpha.2`, and the GitHub release. A tag is a name fixed to one commit. The install guide clones a release tag.

release-please opens the release pull request with `GITHUB_TOKEN`, so GitHub doesn't start CI for it. Before merging, the owner clicks **Approve and run workflows** on it. If GitHub doesn't show that button, the owner closes and reopens the pull request. That starts CI as the owner.

An urgent fix is a normal pull request into `main`. The owner then merges the release pull request early.

The tag ruleset stops anyone from moving or deleting a `v*` tag, except a repository admin, who can fix a wrong tag. It can't stop someone from creating a tag. A repository in a personal account can't give GitHub Actions a bypass in a ruleset. release-please makes its tags through `GITHUB_TOKEN`, so a rule against creating tags would block every release.

## The rules

| Rule | `main` | `v*` tags |
| --- | --- | --- |
| Changes only through a pull request. Direct pushes are blocked. | Yes | Not applicable |
| Force pushes and deletion are blocked. | Yes | Moving and deleting are blocked. |
| Approving reviews required | 0 | Not applicable |
| A code owner must approve. | Yes | Not applicable |
| A new push dismisses earlier approvals. | Yes | Not applicable |
| Required checks, reported by GitHub Actions | `lint`, `typecheck`, `test`, `docs`, `container` | Not applicable |
| The branch must be up to date with its base. | No | Not applicable |
| Merge method | Squash | Not applicable |
| Bypass actors | None | Repository admins |

Nobody can bypass the rules on `main`, including the owner. In an emergency, the owner can set a ruleset's enforcement to **Disabled**, which leaves a record in the ruleset's history.

### Why squash

One pull request becomes one commit on `main`, with a title that follows the Conventional Commit rule. release-please reads those titles to work out the next version and the release notes. A merge commit or a rebase would add each commit of the branch, and those titles don't follow the rule.

### Why 0 approving reviews

GitHub never lets the author of a pull request approve it. The bot authors every pull request, so any number above 0 would block every merge by the bot. The other model family's review is on record in the pull request. The bot merges only once that review's findings are fixed or answered. For the owner's paths, the bot waits for the owner's approval, and the code owner rule below makes GitHub wait too.

### Why a code owner must approve

With "require review from code owners" on, GitHub stops a pull request that changes a path in `CODEOWNERS` until its code owner approves. This is how the owner keeps control of the paths below. A bot's approval never counts for them.

GitHub's documents don't say whether this rule still blocks a merge when 0 approvals are required. [Decision 0062](decisions/0062-one-main-branch.md) named that as an open risk. A test on 2026-11-25 settled it. Test pull request [#197](https://github.com/jcore9/Aphelion/pull/197) changed a decision record. All its checks were green and it had no conflicts. GitHub still refused to merge it and asked `@jcore9` to review it as code owner. The bot closed it without merging. If GitHub ever stops holding these pull requests, the fallback in decision 0062 applies. A second GitHub account posts the review as a real approval, and the rule requires 1 approving review.

### Why the checks must come from GitHub Actions

Anyone with the Write role can set a commit status with any name through the API. Each required check names GitHub Actions (app ID `15368`) as its source, so a status named `lint` from any other source doesn't count.

### Why branches don't have to be up to date

Bringing a branch up to date is a new push, so it dismisses any approval. Suppose several pull requests are open at once. Each merge into `main` would cost every other pull request a new push, a new CI run and a new review. CI also runs on each push to `main`, so a break between two merged pull requests shows on `main` straight away.

When a pull request does need the latest `main`, the bot updates the branch.

## What `CODEOWNERS` covers

The owner is the code owner of the paths the owner always decides:

- `.github/`, which holds the rulesets, the workflows, the templates and `CODEOWNERS` itself
- the release-please config and manifest
- every `package.json` in the repository, and the root `bun.lock` and `bunfig.toml`, because they set the scripts that CI runs, the dependencies, and the package registry
- `eslint.config.ts`, `lint-boundaries.test.ts`, `vitest.config.ts` and every `tsconfig*.json`, which enforce the boundaries in [decision 0023](decisions/0023-scaffold-toolchain.md)
- the decision records, the plan, `SECURITY.md` and `LICENSE`

Security code isn't listed. That means secrets, the broker, auth, devices, the plugin host, the gateway, policy, hooks, adapters, the Dockerfile, Compose files, deploy files and install scripts. The bot merges it after a model from another family has reviewed it, and the owner reviews it at the end of the milestone. Earlier versions of this page listed those paths, guessing where future code would live. Those entries are gone, along with the `* @jcore9` line that made the owner the code owner of everything.

## What the rules don't stop

- A user with the Write role can merge a pull request once it has the approvals and checks it needs. That includes the bot, which is the point of this setup.
- A workflow changed on a branch runs on that branch's pull request before anyone reviews it. Code owners control what merges, not what runs. Pull requests from the same repository get the repository's Actions secrets, so secrets belong in an environment with required reviewers.
- Anyone who can run a workflow with `GITHUB_TOKEN` can create a tag. The tag ruleset only stops a tag from being moved or deleted.
