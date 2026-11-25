# Aphelion docs

This folder holds the Aphelion documentation: the plan, guides, reference pages, spike findings and decision records. The files are Markdown, and they read the same on GitHub and on the docs site. `bun run docs` builds the site with [Starlight](https://starlight.astro.build/) and checks every internal link ([decision 0033](decisions/0033-docs-site-in-place.md)).

## Writing a page

- Start the file with a `# Title` line. The site uses it as the page title, so pages need no frontmatter. Frontmatter is the settings block that some site generators expect at the top of a file.
- Link to another page by its relative path, such as `[decision 0007](decisions/0007-bun-runtime.md)`. The site turns the link into the page's URL. The build fails on a link to a missing page or heading.
- Link to code or anything else outside `docs/` with a full GitHub URL. A relative link to such a file fails the build.
- A new folder at the top of `docs/` needs a symbolic link (a file that points to another folder) in `src/content/docs/`. Without it, the folder's pages don't appear on the site. For example, run `ln -s ../../../guides src/content/docs/guides` from `docs/`.

## Plan

- [Architecture and development plan](plan/aphelion-plan.md) is the plan of record. It was imported unchanged ([decision 0004](decisions/0004-import-plan-with-m0-plan.md)). Later records amend it, and each amendment is marked in the text.
- Milestone plans:
  - [M0: Foundations](plan/milestones/M0-foundations.md)
  - [M0 exit test results](plan/milestones/M0-exit-test.md)
  - [M1: One bot end to end](plan/milestones/M1-one-bot-end-to-end.md)

## Guides

- [Install the headless server](guides/install.md) covers the host, the image, `aphelion.service`, plugins, the network check and upgrades. A headless server runs without a desktop window.
- [Write your first server plugin](guides/write-your-first-server-plugin.md) shows how to create a plugin from the template, test it, build it and reload it in dev mode.
- [How a release happens](guides/releasing.md) covers the release pull requests, the version overrides and the first tag.

## Working on the repository

- [Branch protection](branch-protection.md) says how changes reach `main`. It also lists the rules that protect `main` and the release tags.

## Spike findings

A spike is a research task. Each spike answers its questions in writing before anything builds on it. Its prototype code stays on its `spike/` branch and is never merged.

- [M0-01: Claude over ACP on a subscription login](spikes/M0-01-claude-over-acp.md)
- [M0-02: Grok headless billing](spikes/M0-02-grok-headless-billing.md)
- [M0-03: headless without Electron, on Bun](spikes/M0-03-headless-on-bun.md)
- [M0-17: Codex headless on a ChatGPT login](spikes/M0-17-codex-headless.md)
- [M0-18: per-bot isolation with user namespaces](spikes/M0-18-namespaces.md)
- [M0-24: signing in to AI tools from the app](spikes/M0-24-sign-in-from-the-app.md)
- [M0-10b: Tailscale `whois` from inside the container](spikes/M0-10b-tailscale-whois.md)

## Reference

- [The aphelion command](reference/cli.md) covers `--headless`, `--version`, `config check` and the `device` commands, their options, output and exit codes.
- [The host command](reference/host-command.md) covers `sudo aphelion status`, `device` and `check` on the server, what each prints and its exit codes.
- [Config reference](reference/config.md) covers the files in `/etc/aphelion/`, their fields and versions, the owner and mode check, and the errors.
- [The SQLite store](reference/store.md) covers the `Database` interface and how to add a migration.
- [Logging and the audit log](reference/logging.md) covers the log format, the redaction rules and how to add one, and the append-only audit table.
- [The HTTP and WebSocket server](reference/server.md) covers where the server listens and what `/health` returns. It also covers what each request gets with and without a device token, the WebSocket limits and the Compose port rule.
- [Device tokens](reference/devices.md) covers how a device token is made, stored, checked, expired and revoked, and what is audited.
- [The client protocol](reference/protocol.md) covers how frames, sequence numbers, replay, resync and command ids work.
- [Protocol spec](reference/protocol-spec.md) lists every frame, command, event and error code, generated from the protocol schemas.
- [Plugin manifest](reference/plugin-manifest.md) covers the fields of `aphelion-plugin.json`, the API-range rule and the secret backend type.
- [Plugin API reference](reference/plugin-api.md) lists every type, function and constant in `@aphelion/plugin-sdk`, generated from the SDK's types and doc comments.
- [Running plugins on the server](reference/plugins.md) covers how the plugin host and the plugin runner start, talk to, restart and stop a plugin's server part. It also covers the plugin's environment and data folder and the JSON-RPC messages.
- [The container](reference/container.md) covers the image, the four users and the folders. It also covers how the launcher starts and stops the processes, the hardening, the network boundary and the contract tests.
- [Secrets](reference/secrets.md) covers the `Secret` type, what it guarantees and what it doesn't, how to read a value, and the secret reference syntax.

## Decision records

Each significant decision has one numbered record. A record lists the context, the options, the choice and the consequences. Start a new record from [the template](decisions/template.md).

| # | Decision | Status |
| --- | --- | --- |
| [0001](decisions/0001-planning-issue-per-milestone.md) | Every milestone gets an M#-00 planning issue | Accepted |
| [0002](decisions/0002-type-docs-label.md) | Add a `type/docs` label and infer area and type labels per issue | Accepted |
| [0003](decisions/0003-release-versioning.md) | Milestone releases use pre-release tags | Accepted |
| [0004](decisions/0004-import-plan-with-m0-plan.md) | Import the plan verbatim with the M0 plan | Accepted |
| [0005](decisions/0005-bot-account-authors-prs.md) | A bot account authors agent PRs | Accepted |
| [0006](decisions/0006-shared-bot-user.md) | All bots share one Unix user; bots manage bots through tools | Accepted |
| [0007](decisions/0007-bun-runtime.md) | Bun is the server runtime and package manager; Vitest runs the tests | Accepted |
| [0008](decisions/0008-react-and-tailwind.md) | The web client uses React and Tailwind | Accepted |
| [0009](decisions/0009-electron-desktop-shell.md) | Electron is the desktop shell, and the server runs beside it as a Bun process | Accepted |
| [0010](decisions/0010-bot-folders.md) | Each bot has a folder; instructions live there, permissions stay in the server's config | Accepted |
| [0011](decisions/0011-ubuntu-lts.md) | v1 supports the current Ubuntu LTS | Accepted |
| [0012](decisions/0012-secrets-broker-process.md) | The secrets broker is its own process from the start | Accepted |
| [0013](decisions/0013-tailscale-identity.md) | Tailscale identity ships in M0 only if it needs no operator rights | Accepted |
| [0014](decisions/0014-filesystem-layout.md) | Config in /etc/aphelion, state in /var/lib/aphelion, bots in /var/lib/aphelion-bots | Accepted |
| [0015](decisions/0015-1password-ci-mock.md) | The 1Password backend is tested against a mock in CI | Accepted |
| [0016](decisions/0016-one-docker-container.md) | The headless server ships as one Docker container, with separate users inside | Accepted |
| [0017](decisions/0017-desktop-remote-only.md) | The desktop app only connects to a server; it never runs one | Accepted |
| [0018](decisions/0018-shared-plugin-user.md) | Server plugins share one user and are started by a plugin runner | Accepted |
| [0019](decisions/0019-cli-subscription-use.md) | Bots run the Claude and Grok CLIs on the owner's own subscription logins | Accepted |
| [0020](decisions/0020-1password-grok-bot-style.md) | 1Password works like Grok Bot's, built on a service account | Accepted |
| [0021](decisions/0021-container-init-and-secret-handoff.md) | The container's init is tini plus setpriv, and the bootstrap secret arrives on stdin | Accepted |
| [0022](decisions/0022-bot-network-boundary.md) | The host firewall blocks the container from the LAN, with a path to a separate bots container | Accepted |
| [0023](decisions/0023-scaffold-toolchain.md) | The scaffold lints with ESLint and typescript-eslint on TypeScript 6.0, and formats with Prettier | Accepted |
| [0024](decisions/0024-codex-third-bot-cli.md) | Codex CLI becomes a third bot CLI, spiked in M0 and built in M4 | Accepted |
| [0025](decisions/0025-config-schema-and-format.md) | Config files are YAML, parsed with the `yaml` package and validated with Zod 4 | Accepted |
| [0026](decisions/0026-sqlite-driver.md) | The store uses `bun:sqlite` in an adapter, and migrations are TypeScript modules | Accepted |
| [0027](decisions/0027-acp-first-adapters.md) | Bot adapters speak ACP first, with stream-json as a fallback per provider | Accepted, amended by 0034 |
| [0028](decisions/0028-policy-engine-in-harness.md) | The policy engine runs inside the harness for v1 | Accepted |
| [0029](decisions/0029-hosted-reviewer-model.md) | The reviewer is a small hosted model, called with an API key | Accepted |
| [0030](decisions/0030-native-connectors.md) | Connectors are native, starting with GitHub | Accepted |
| [0031](decisions/0031-unprivileged-bots.md) | Bots run as unprivileged users | Accepted |
| [0032](decisions/0032-native-app-stack-deferred.md) | The native app stack is chosen in M9 | Accepted |
| [0033](decisions/0033-docs-site-in-place.md) | The docs site reads the Markdown files where they are, and takes each page title from its first heading | Accepted |
| [0034](decisions/0034-vendor-protocol-per-cli.md) | Each bot CLI is driven over its vendor's own protocol | Accepted |
| [0035](decisions/0035-codex-login-sandbox-approvals.md) | Codex runs on the owner's ChatGPT login, with its own sandbox in the container and `untrusted` approvals on a pinned version | Accepted |
| [0036](decisions/0036-logging-library.md) | The server writes its own JSON logs, with no logging library | Accepted |
| [0037](decisions/0037-protocol-frames-in-zod.md) | Protocol frames are Zod 4 schemas, and the TypeScript types come from them | Accepted |
| [0038](decisions/0038-plugin-manifest-and-api-range.md) | A plugin's manifest is `aphelion-plugin.json`, checked with Zod 4, and its API range is checked with the `semver` package | Accepted |
| [0039](decisions/0039-bots-not-agents.md) | Aphelion's bots are called bots, not agents, in the code, the docs and the issues | Accepted |
| [0040](decisions/0040-protocol-spec-generator.md) | A test renders the protocol spec and the frame JSON Schemas from the Zod schemas, and fails when the committed files are stale | Accepted |
| [0041](decisions/0041-effect-in-server-and-cli.md) | The server and the CLI use the Effect library, and nothing else does | Accepted |
| [0042](decisions/0042-plugin-server-and-client-parts.md) | A plugin has a server part, a client part or both, and its client part is installed on the server, served to every client and always sandboxed | Accepted |
| [0043](decisions/0043-http-server-on-effect-platform-bun.md) | The server listens through `@effect/platform-bun`'s HTTP server, in an adapter | Accepted |
| [0044](decisions/0044-secret-type.md) | `Secret` is a small class of Aphelion's own, modelled on Effect's `Redacted`, and it throws when serialized | Accepted |
| [0045](decisions/0045-no-bot-namespaces-default-seccomp.md) | Bots get no namespaces of their own, the container keeps Docker's default seccomp profile, and Codex runs without its own sandbox | Accepted |
| [0046](decisions/0046-plugin-runner-kills-process-trees.md) | The plugin runner adopts every process its plugins leave behind, and freezes then kills a plugin's whole process tree | Accepted |
| [0047](decisions/0047-repo-layout.md) | The code is split into apps and shared packages, and the server and its CLI are one package in `apps/server` | Accepted |
| [0048](decisions/0048-cli-on-node-parseargs.md) | The aphelion command reads its command line with Node's parseArgs, and Docker's Compose output reaches config check through standard input | Accepted |
| [0049](decisions/0049-ai-tools-installed-from-a-list.md) | The container image ships no AI tool, and the owner installs AI tools from a list | Accepted |
| [0050](decisions/0050-bootstrap-key-is-the-store-key.md) | The host's bootstrap credential is the local store's age key | Accepted |
| [0051](decisions/0051-plugin-dev-kit.md) | The plugin dev kit has a stdio entry in the SDK, reloads through the running server, and generates from a checkout | Accepted |
| [0052](decisions/0052-plugin-api-reference-generator.md) | A test generates the plugin API reference from the SDK's types and doc comments with the TypeScript compiler, and fails when the page is stale | Accepted |
| [0053](decisions/0053-1password-token-and-move-to-m3.md) | The 1Password token lives in the local store, and the 1Password plugin moves from M0 to M3 | Accepted |
| [0054](decisions/0054-graceful-plugin-stop-deadlines.md) | At service stop each plugin gets 5 seconds with a 10-second cap for all, and the SDK waits up to 3 seconds for running event handlers before cleanup | Accepted |
| [0055](decisions/0055-compose-check-server-listener.md) | With `--compose`, the config check requires the server to listen on 0.0.0.0 port 7400 | Accepted |
| [0056](decisions/0056-test-host-event-limit-and-dev-crash-notice.md) | The test host rejects an event the real host would refuse, and `plugin dev` reports a crash after the handshake | Accepted |
| [0057](decisions/0057-plugin-updates-from-github-releases.md) | The server updates a plugin from its GitHub releases, proven genuine by an artifact attestation, on the owner's approval and with no restart | Accepted |
| [0058](decisions/0058-specialized-bots.md) | Each bot starts with no connectors or plugins, and the owner switches on the ones it may use | Accepted |
| [0059](decisions/0059-backup-and-restore-drill.md) | A backup is one archive of the six volumes plus the key's recovery copy, and the M0 exit test restores it on a second VM | Accepted |
| [0060](decisions/0060-server-stays-on-linux-with-api-keys-and-two-plugin-fixes.md) | The server stays on Linux in Docker and also builds for arm64, API keys join sign-ins, and two plugin isolation gaps close in M5 | Accepted |
| [0061](decisions/0061-release-please.md) | release-please sets the version, the release notes and the tag from commit titles, through a release PR into `main` | Accepted |
| [0062](decisions/0062-one-main-branch.md) | From M1, Aphelion works on one `main` branch, and jcore9-bot squash-merges its own pull requests after another model family has reviewed them | Accepted |
| [0063](decisions/0063-m1-planning-answers.md) | Before M2 approvals, the first bot works in its own folder, and M1 takes four other choices | Accepted |
| [0064](decisions/0064-linked-equal-servers.md) | Two or more Aphelion servers can link up as equals, with groundwork in M1 and the build after v1.0 | Accepted |
| [0066](decisions/0066-grok-checksum-recorded-by-aphelion.md) | Aphelion records its own checksum for Grok Build, because xAI publishes none | Proposed |
