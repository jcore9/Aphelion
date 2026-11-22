# 0047. The code is split into apps and shared packages, and the server and its CLI are one package in `apps/server`

- Status: Proposed
- Date: 2026-11-22
- Proposed by: the repo layout PR ([#146](https://github.com/jcore9/Aphelion/issues/146))
- Answers: the owner's choice of 2026-11-22 to lay the code out as separate apps plus shared packages, and the issue's open question of how `packages/cli` joins the server
- Amends: the folder paths in [decision 0023](0023-scaffold-toolchain.md) and [decision 0041](0041-effect-in-server-and-cli.md), and the M0 plan's M0-04 and M0-11 notes

## Context

Some words used below:

- A **workspace** is one folder of the repository that Bun treats as its own package, with its own `package.json` and its own name, such as `@aphelion/server`. Workspaces import each other by those names.
- An **app** is a program someone runs: the server, the desktop app or the phone app.
- A **package** is code that apps share, such as the message formats.

Until now every workspace sat in `packages/`: `server`, `cli`, `client`, `protocol` and `plugin-sdk`. On 2026-11-22 the owner said they see Aphelion as separate apps and chose this layout:

```
apps/
  server/    the server and its CLI, one program
  desktop/   the Electron app (M5), empty for now
  mobile/    the phone app (M9), empty for now
packages/
  protocol/    messages between the apps
  plugin-sdk/  what plugin authors use
  ui/          shared screens (React), for desktop, mobile where it can, and the web app the server serves
docs/
```

The web app stays: the server serves it, built from `packages/ui`. Plugins keep one shared client part ([decision 0042](0042-plugin-server-and-client-parts.md)).

Moving folders conflicts with every open branch, so the move waited until no PRs were open. It comes before the CLI (#13), so the CLI is built in its final place.

## Options

### How the CLI joins the server

`packages/cli` held one line, `export {};`. No code used it.

| Option | For | Against |
| --- | --- | --- |
| **One package, `@aphelion/server`.** CLI code goes in `apps/server/src/cli/`, and its Bun-only parts go in `apps/server/src/adapters/` with the server's | Matches "one program". One `package.json`, one adapter folder, one lint rule. The CLI calls server code, such as `checkComposePorts`, without a package boundary in between | The CLI can't be published on its own. Nothing plans to do that, since the desktop app doesn't bundle it ([decision 0017](0017-desktop-remote-only.md)) |
| Two packages inside `apps/server` (`apps/server/server` and `apps/server/cli`) | Keeps a hard line between CLI and server code | Two workspaces for one program, a nested layout no other folder has, and a second adapter folder for lint and `CODEOWNERS` to track |

### What the shared screens are called

| Option | For | Against |
| --- | --- | --- |
| **`@aphelion/ui`**, matching the folder | The folder and the name agree, as in every other workspace | None found. Nothing imported `@aphelion/client` |
| Keep `@aphelion/client` in `packages/ui` | No rename | A folder and a name that disagree |

### The empty apps

| Option | For | Against |
| --- | --- | --- |
| **A one-paragraph `README.md` in `apps/desktop` and `apps/mobile`** | Git keeps the folders, and anyone browsing sees what goes there and when | None found |
| An empty workspace with a `package.json` | Ready to fill | An empty package that typecheck and the lockfile track for milestones |

Bun's workspace pattern `apps/*` skips a folder with no `package.json`. This was checked with Bun 1.4.5: `bun install` lists only `apps/server` among the apps.

### Old decision records

| Option | For | Against |
| --- | --- | --- |
| **Keep each record's text as written, and change only its links to GitHub** | A record shows what was decided at the time. The links keep working | A record's text names a path that has since moved. This record's table below maps them |
| Rewrite every path in every record | Every path is current | Rewrites approved records, and sentences about `packages/cli` stop making sense once it is gone |

## Decision

Take the options in bold above:

- **One package.** The server and its CLI are one workspace, `@aphelion/server`, in `apps/server`. The CLI's code goes in `apps/server/src/cli/`.
- **`@aphelion/ui`** is the name of the shared screens in `packages/ui`.
- **A `README.md`** holds the place of `apps/desktop` and `apps/mobile` until M5 and M9 add a `package.json`.
- **Old records keep their text.** Only their GitHub links change.

The paths move like this:

| Before | After |
| --- | --- |
| `packages/server` (`@aphelion/server`) | `apps/server` (`@aphelion/server`) |
| `packages/cli` (`@aphelion/cli`) | removed, the CLI goes in `apps/server/src/cli/` |
| `packages/cli/src/adapters/` | `apps/server/src/adapters/` |
| `packages/client` (`@aphelion/client`) | `packages/ui` (`@aphelion/ui`) |
| `packages/protocol`, `packages/plugin-sdk` | unchanged |
| none | `apps/desktop`, `apps/mobile` |

The boundary rules of [decision 0023](0023-scaffold-toolchain.md) and [decision 0041](0041-effect-in-server-and-cli.md) keep their meaning, with the new paths:

| Code in | Rule |
| --- | --- |
| `apps/server/src/adapters/` | The only place for `bun`, `bun:*`, the `Bun` global, `@effect/platform-bun` and `@effect/sql-sqlite-bun` |
| `apps/server` | May use Effect |
| `packages/protocol`, `packages/plugin-sdk`, `packages/ui` | Web-standard APIs only: no Bun, no Node built-ins, no Effect, and no imports of `@aphelion/server` or `@aphelion/ui` |

`eslint.config.ts` enforces these rules and `lint-boundaries.test.ts` checks the rule set. The desktop and phone apps get their own rules when they get code, since Electron's main process uses Node.

## Consequences

- One script made the move, so a reviewer can rerun it on `dev` and get the same tree. The PR for #146 holds the script.
- The CLI (#13) is built in `apps/server/src/cli/`, with its Bun-only parts in `apps/server/src/adapters/`.
- `CODEOWNERS` keeps one Bun-only adapter folder, `apps/server/src/adapters/`.
- M5 adds `apps/desktop/package.json` and M9 adds `apps/mobile/package.json`. Each adds lint rules for its app then.
- No open issue named an old path apart from #146 itself, so no issue bodies changed.
- Revisit if the CLI ever has to ship without the server.
