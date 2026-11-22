# Aphelion docs

These Markdown files read the same on GitHub and on the docs site. `bun run docs` builds the site with [Starlight](https://starlight.astro.build/) and checks every internal link ([decision 0033](decisions/0033-docs-site-in-place.md)).

## Writing a page

- Start the file with a `# Title` line. The site uses it as the page title, so pages need no frontmatter.
- Link to another page by its relative path, such as `[decision 0007](decisions/0007-bun-runtime.md)`. The site turns the link into the page's URL, and the build fails on a link to a missing page or heading.
- Link to code or anything else outside `docs/` with a full GitHub URL. A relative link to such a file fails the build.
- A new folder at the top of `docs/` needs a symbolic link in `src/content/docs/`, or its pages don't appear on the site. For example, run `ln -s ../../../guides src/content/docs/guides` from `docs/`.

## Plan

- [Architecture and development plan](plan/aphelion-plan.md): the plan of record, imported unchanged ([decision 0004](decisions/0004-import-plan-with-m0-plan.md)). Later records amend it, and each amendment is marked in the text.
- Milestone plans:
  - [M0: Foundations](plan/milestones/M0-foundations.md)

## Working on the repository

- [Branch protection](branch-protection.md): how changes reach `dev` and `main`, and why.

## Spike findings

Each spike answers its questions in writing before anything builds on it. Prototype code stays on its `spike/` branch and is never merged.

- [M0-01: Claude over ACP on a subscription login](spikes/M0-01-claude-over-acp.md)
- [M0-02: Grok headless billing](spikes/M0-02-grok-headless-billing.md)
- [M0-03: headless without Electron, on Bun](spikes/M0-03-headless-on-bun.md)
- [M0-17: Codex headless on a ChatGPT login](spikes/M0-17-codex-headless.md)

## Reference

- [Config reference](reference/config.md): the files in `/etc/aphelion/`, their fields and versions, the owner and mode check, and the errors.
- [The SQLite store](reference/store.md): the `Database` interface, and how to add a migration.
- [Logging and the audit log](reference/logging.md): the log format, the redaction rules and how to add one, and the append-only audit table.

## Decision records

One numbered record per significant decision: context, options, choice, consequences. Start a new record from [the template](decisions/template.md).

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
| [0020](decisions/0020-1password-grok-bot-style.md) | 1Password works like Grok Bot's, built on a service account | Accepted |
| [0021](decisions/0021-container-init-and-secret-handoff.md) | The container's init is tini plus setpriv, and the bootstrap secret arrives on stdin | Accepted |
| [0022](decisions/0022-agent-network-boundary.md) | The host firewall blocks the container from the LAN, with a path to a separate agents container | Accepted |
| [0023](decisions/0023-scaffold-toolchain.md) | The scaffold lints with ESLint and typescript-eslint on TypeScript 6.0, and formats with Prettier | Accepted |
| [0024](decisions/0024-codex-third-agent-cli.md) | Codex CLI becomes a third agent CLI, spiked in M0 and built in M4 | Accepted |
| [0025](decisions/0025-config-schema-and-format.md) | Config files are YAML, parsed with the `yaml` package and validated with Zod 4 | Proposed |
| [0026](decisions/0026-sqlite-driver.md) | The store uses `bun:sqlite` in an adapter, and migrations are TypeScript modules | Proposed |
| [0027](decisions/0027-acp-first-adapters.md) | Agent adapters speak ACP first, with stream-json as a fallback per provider | Accepted |
| [0028](decisions/0028-policy-engine-in-harness.md) | The policy engine runs inside the harness for v1 | Accepted |
| [0029](decisions/0029-hosted-reviewer-model.md) | The reviewer is a small hosted model, called with an API key | Accepted |
| [0030](decisions/0030-native-connectors.md) | Connectors are native, starting with GitHub | Accepted |
| [0031](decisions/0031-unprivileged-agents.md) | Agents run as unprivileged users | Accepted |
| [0032](decisions/0032-native-app-stack-deferred.md) | The native app stack is chosen in M9 | Accepted |
| [0033](decisions/0033-docs-site-in-place.md) | The docs site reads the Markdown files where they are, and takes each page title from its first heading | Proposed |
| [0036](decisions/0036-logging-library.md) | The server writes its own JSON logs, with no logging library | Proposed |
