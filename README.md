# Aphelion

Aphelion is a bot application that you run on your own server. Its bots are long-running managers and orchestrators. A bot plans work and tracks it in connected services such as GitHub. Bots message each other and hand tasks to each other. For hands-on coding, a bot delegates to a dedicated tool such as T3 Code. It does this over MCP, the Model Context Protocol, a standard way for programs to call each other's tools. Aphelion is not a coding app. It has no code editor, no diff viewer and no terminal screen.

The rest of this section describes the design. Most of it isn't built yet.

Bots run the official, unmodified Claude Code and Grok Build command-line tools (CLIs). They use the owner's own subscription logins ([decision 0019](docs/decisions/0019-cli-subscription-use.md)). Codex is planned as a third CLI. The M0-17 spike is a short research task that must confirm it first ([decision 0024](docs/decisions/0024-codex-third-bot-cli.md)). Every risky tool call goes through an approval layer that the owner configures. A rule can allow the call, a reviewer model can release it, or Aphelion can send it to the owner to decide.

Aphelion does not trust the bots, so the rules that limit them live outside their reach. The server runs as one hardened Docker container. The container's root filesystem is read-only. Docker drops every Linux capability except two. A capability is a special right that a process can hold. The init process needs those two to start processes as other users. Inside the container, the server, the bots, the secrets broker and the plugins run as separate Unix users ([decision 0016](docs/decisions/0016-one-docker-container.md)). The server's port is published only on the host's Tailscale address. Every API call except `/health` needs a device token, even from inside the container ([decision 0022](docs/decisions/0022-bot-network-boundary.md)).

The clients only connect to a server. They never run one ([decision 0017](docs/decisions/0017-desktop-remote-only.md)). There are two clients. One is a web app that you can install like an app (a PWA, or progressive web app). The other is a desktop app built with Electron.

## Status

Aphelion is alpha. M0, Foundations, ships as `v0.1.0-alpha.1`. It is a server you can [install](docs/guides/install.md). It has device tokens, a secrets broker and plugins, but no bots yet. The [release notes](https://github.com/jcore9/Aphelion/releases) list what ships and the known limits. The [M0 plan](docs/plan/milestones/M0-foundations.md) lists what M0 builds.

## Docs

- [Docs index](docs/README.md) links the plan, the spike findings and the decision records.
- [Architecture and development plan](docs/plan/aphelion-plan.md) is the plan of record.
- [CONTRIBUTING.md](CONTRIBUTING.md) says how to work in this repository.
- [SECURITY.md](SECURITY.md) says how to report a vulnerability.

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
   bun run docs
   ```

`bun run format` rewrites code in the Prettier style that `lint` checks.

To run the server from source, do three things. Give it a config folder and a state folder that only you can read. Make it listen on `127.0.0.1` only. Then start it:

```sh
cp -r docs/reference/config/example /tmp/aphelion-etc && chmod 750 /tmp/aphelion-etc && chmod 640 /tmp/aphelion-etc/*
sed -i 's/0.0.0.0/127.0.0.1/' /tmp/aphelion-etc/server.yaml
mkdir -m 700 /tmp/aphelion-state
bun apps/server/src/cli/main.ts --headless --config-dir /tmp/aphelion-etc --state-dir /tmp/aphelion-state
```

[The `aphelion` command](docs/reference/cli.md) lists the other commands.

`bun run docs` builds the docs site into `docs/dist/` and fails on a broken internal link. `bun run --filter @aphelion/docs dev` serves the site and reloads it when a file changes. [The docs index](docs/README.md) says how the site reads the files.

The code has two kinds of folder. Apps are programs you run. Packages hold code that the apps share ([decision 0047](docs/decisions/0047-repo-layout.md)):

| Folder | What it holds |
| --- | --- |
| `apps/server` | The server and its command line, one program |
| `apps/desktop` | The desktop app (M5), empty for now |
| `apps/mobile` | The phone app (M9), empty for now |
| `packages/protocol` | The messages the server and the apps exchange |
| `packages/plugin-sdk` | What plugin authors use |
| `packages/ui` | The shared screens, for the desktop app, the phone app and the web app the server serves |
| `docs` | This documentation |

Code may use Bun-only APIs only in `apps/server/src/adapters/`. The `protocol`, `plugin-sdk` and `ui` packages use web-standard APIs only. [Decision 0023](docs/decisions/0023-scaffold-toolchain.md) lists the rules, and lint enforces them.

## License

Aphelion is released under the [MIT License](LICENSE).
