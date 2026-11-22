# Contributing to Aphelion

Most of the code here is written by coding agents, and the owner reviews and merges it. These rules apply to people and agents alike. The [Development workflow](docs/plan/aphelion-plan.md#development-workflow) section of the plan is the full version.

## Plan before code

Nothing is built without a written plan.

- Every milestone opens with a planning issue, M#-00. The milestone's other issues start after the owner approves that plan ([decision 0001](docs/decisions/0001-planning-issue-per-milestone.md)).
- Every significant design choice gets a decision record in [`docs/decisions/`](docs/decisions/) before the code that depends on it. A record lists the context, the options, the choice and the consequences. Copy the format of [0023](docs/decisions/0023-scaffold-toolchain.md), set its status to **Proposed**, and add its row to the table in [`docs/README.md`](docs/README.md).
- The plan lives in the repo at [`docs/plan/`](docs/plan/) ([decision 0004](docs/decisions/0004-import-plan-with-m0-plan.md)). Link to it instead of copying from it.

## One issue, one branch, one PR

1. Pick an issue whose milestone plan is approved and whose dependencies have merged.
2. Create a branch from `dev` for that issue alone. Name it `<type>/<issue-id>-<slug>`, for example `chore/M0-04-monorepo-scaffold` or `feat/M3-04-github-app`. The prefix is `feat/`, `fix/`, `docs/`, `spike/` or `chore/`.
3. Open one small PR into `dev`. Aim for under about 400 changed lines, not counting tests and generated files. A PR never mixes a refactor with a feature, or two features.
4. Fill in the PR template. Write `Closes #<issue>` and add the labels that apply. GitHub closes issues on its own only for PRs into `main`, so close the issue by hand once the PR merges into `dev`.
5. Give the PR a Conventional Commit title, such as `feat(server): ...` or `docs: ...`. The owner squash-merges it into `dev`, and the title becomes the commit on `dev`.

Spikes end in a written finding under `docs/spikes/`. Their prototype code stays on the `spike/` branch and never merges.

## Coding agents use the bot account

Coding agents open PRs from the `jcore9-bot` account, never from the owner's account ([decision 0005](docs/decisions/0005-bot-account-authors-prs.md)). GitHub doesn't let a PR's author approve it, so the owner can review only what the bot opens.

- Agents commit with the bot's noreply address, `356729618+jcore9-bot@users.noreply.github.com`.
- PRs from the bot carry the `agent-authored` label.
- Agents open PRs but never approve or merge them.

## Docs ship with the change

A PR that changes behavior, config, the protocol or a public API updates the affected docs in the same PR. The PR template asks which docs you touched.

## Run the checks before you push

Run the three checks from the [Develop section of the README](README.md#develop). All three must pass, and CI runs the same ones.

```sh
bun run lint
bun run typecheck
bun run test
```

## Labels

Every issue gets one type label and the area labels that fit. An issue that touches a security-sensitive path also gets `risk/security`, so its PR gets a full review from the start. A PR carries the risk labels that apply. [Decision 0002](docs/decisions/0002-type-docs-label.md) sets this list.

| Label | Use it for |
| --- | --- |
| `type/feature` | A new capability |
| `type/chore` | Tooling, tests, CI and repo maintenance |
| `type/docs` | Milestone plans and docs-only work |
| `type/spike` | A timeboxed question answered in writing, not shipped code |
| `area/server` | The server: API, session manager, store, scheduler |
| `area/client` | The web client, protocol consumers and test clients |
| `area/gateway` | The connector gateway and connectors |
| `area/plugins` | The plugin host, the SDK and first-party plugins |
| `area/desktop` | The Electron shell, packaging and headless mode |
| `area/security` | Isolation, policy, secrets and auth |
| `risk/security` | A change to a security-sensitive path. It gets a full line-by-line review. |
| `risk/breaking` | A breaking change. The changelog needs migration notes. |
| `agent-authored` | A PR or issue opened by an agent or coding tool |

The security-sensitive paths are the policy engine, the secrets broker, the gateway, auth, plugin permissions and the install script. Anything that adds a permission, a secret or a network host also gets `risk/security`.

## Scope

Aphelion is a bot application for managers and orchestrators, not a coding app. A change that adds a code editor, diff review or a terminal UI is out of scope.

## Security issues

Don't report a vulnerability in a public issue. Follow [SECURITY.md](SECURITY.md).
