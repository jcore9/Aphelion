# Aphelion docs

These are plain Markdown files until M0-16 builds them into a Starlight site.

## Plan

- [Architecture and development plan](plan/aphelion-plan.md): the plan of record, imported unchanged ([decision 0004](decisions/0004-import-plan-with-m0-plan.md)).
- Milestone plans:
  - [M0: Foundations](plan/milestones/M0-foundations.md)

## Spike findings

Each spike answers its questions in writing before anything builds on it. Prototype code stays on its `spike/` branch and is never merged.

- [M0-01: Claude over ACP on a subscription login](spikes/M0-01-claude-over-acp.md)
- [M0-02: Grok headless billing](spikes/M0-02-grok-headless-billing.md)

## Decision records

One numbered record per significant decision: context, options, choice, consequences.

| # | Decision | Status |
| --- | --- | --- |
| [0001](decisions/0001-planning-issue-per-milestone.md) | Every milestone gets an M#-00 planning issue | Accepted |
| [0002](decisions/0002-type-docs-label.md) | Add a `type/docs` label and infer area and type labels per issue | Accepted |
| [0003](decisions/0003-release-versioning.md) | Milestone releases use pre-release tags | Accepted |
| [0004](decisions/0004-import-plan-with-m0-plan.md) | Import the plan verbatim with the M0 plan | Accepted |
| [0005](decisions/0005-bot-account-authors-prs.md) | A bot account authors agent PRs | Accepted |
| [0006](decisions/0006-shared-agent-user.md) | All agents share one Unix user; agents manage agents through tools | Accepted |
| [0007](decisions/0007-bun-runtime.md) | Bun is the server runtime and package manager; Vitest runs the tests | Accepted |
| [0008](decisions/0008-react-and-tailwind.md) | The web client uses React and Tailwind | Accepted |
| [0009](decisions/0009-electron-desktop-shell.md) | Electron is the desktop shell, and the server runs beside it as a Bun process | Accepted |
| [0010](decisions/0010-agent-folders.md) | Each agent has a folder; instructions live there, permissions stay in the server's config | Accepted |
| [0011](decisions/0011-ubuntu-lts.md) | v1 supports the current Ubuntu LTS | Accepted |
| [0012](decisions/0012-secrets-broker-process.md) | The secrets broker is its own process from the start | Accepted |
| [0013](decisions/0013-tailscale-identity.md) | Tailscale identity ships in M0 only if it needs no operator rights | Accepted |
| [0014](decisions/0014-filesystem-layout.md) | Config in /etc/aphelion, state in /var/lib/aphelion, agents in /var/lib/aphelion-agents | Accepted |
| [0015](decisions/0015-1password-ci-mock.md) | The 1Password backend is tested against a mock in CI | Accepted |
| [0016](decisions/0016-one-docker-container.md) | The headless server ships as one Docker container, with separate users inside | Accepted |
| [0017](decisions/0017-desktop-remote-only.md) | The desktop app only connects to a server; it never runs one | Accepted |
| [0018](decisions/0018-shared-plugin-user.md) | Server plugins share one user and are started by a plugin runner | Accepted |
| [0019](decisions/0019-cli-subscription-use.md) | Agents run the Claude and Grok CLIs on the owner's own subscription logins | Accepted |
