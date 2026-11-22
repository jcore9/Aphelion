# Aphelion

Aphelion is a self-hosted bot application. Its bots, called agents, are persistent managers and orchestrators. They plan work, track it across connected services such as GitHub, message each other and hand off tasks, and delegate hands-on coding to dedicated tools such as T3 Code over MCP. Aphelion is not a coding app. It has no code editor, diff viewer or terminal UI.

This section describes the design. Most of it isn't built yet.

Agents drive the official, unmodified Claude Code and Grok Build CLIs on the owner's own subscription logins ([decision 0019](docs/decisions/0019-cli-subscription-use.md)). Codex is planned as a third CLI, pending the M0-17 spike ([decision 0024](docs/decisions/0024-codex-third-agent-cli.md)). Every risky tool call goes through an approval layer that the owner configures. A call is allowed by a rule, released by a reviewer model, or sent to the owner to decide.

The agents are untrusted, so the rules that gate them live outside their reach. The server runs as one hardened Docker container with a read-only root filesystem. Every capability is dropped except the two the init needs to start processes as other users. Inside the container, the server, the agents, the secrets broker and the plugins run as separate Unix users ([decision 0016](docs/decisions/0016-one-docker-container.md)). The server's port is published only on the host's Tailscale address, and every API call except `/health` needs a device token, even from inside the container ([decision 0022](docs/decisions/0022-agent-network-boundary.md)).

The clients only connect to a server. They never run one ([decision 0017](docs/decisions/0017-desktop-remote-only.md)). The clients are a web app that installs as a PWA and an Electron desktop app.

## Status

Aphelion is pre-alpha. Work is in milestone M0, Foundations, and nothing is ready to install yet. The [M0 plan](docs/plan/milestones/M0-foundations.md) lists what M0 builds.

## Docs

- [Docs index](docs/README.md): the plan, the spike findings and the decision records.
- [Architecture and development plan](docs/plan/aphelion-plan.md): the plan of record.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to work in this repo.
- [SECURITY.md](SECURITY.md): how to report a vulnerability.

## Develop

You need [Bun](https://bun.sh) 1.4.5, the version pinned in `package.json`.

1. Install the dependencies:

   ```sh
   bun install
   ```

2. Run the checks that CI runs:

   ```sh
   bun run lint
   bun run typecheck
   bun run test
   ```

`bun run format` rewrites code in the Prettier style that `lint` checks.

The workspaces are `packages/server`, `packages/client`, `packages/protocol`, `packages/plugin-sdk`, `packages/cli` and `docs`. Bun-only APIs are allowed only in `src/adapters/` in `server` and `cli`. `protocol`, `plugin-sdk` and `client` use web-standard APIs only. [Decision 0023](docs/decisions/0023-scaffold-toolchain.md) lists the rules, and lint enforces them.

## License

Aphelion is released under the [MIT License](LICENSE).
