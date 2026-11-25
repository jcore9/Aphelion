# 0048. The aphelion command reads its command line with Node's parseArgs, and Docker's Compose output reaches config check through standard input

- Status: Accepted (approved by merging #151 on 2026-11-22). Parser part superseded by [0067](0067-cli-on-effect-cli.md)
- Date: 2026-11-22
- Proposed by: the CLI and headless mode PR ([#13](https://github.com/jcore9/Aphelion/issues/13))
- Answers: how M0-11 reads the command line, and how `aphelion config check` gets the output of `docker compose config`
- Amends: the M0 plan's M0-11 note, which adds `device list` and `device revoke` to the commands

## Context

M0-11 builds the `aphelion` command: `--headless`, `--version`, `config check` and, for [#98](https://github.com/jcore9/Aphelion/issues/98), `device add`. It lives in `apps/server/src/cli/` ([decision 0047](0047-repo-layout.md)). The server uses the Effect library ([decision 0041](0041-effect-in-server-and-cli.md)), and all validation uses Zod (the owner's decision of 2026-11-22, recorded in 0041).

Two questions came up while building it.

1. **Which code reads the command line.** A command-line parser turns the words typed after `aphelion`, such as `device add laptop --days 30`, into a command and its values, and refuses words it doesn't know.
2. **How `config check` gets the Compose model.** The owner decided on 2026-11-22 (PR #137) that the check reads the output of `docker compose --profile '*' config`, which fills in variables and merges override files. The `aphelion` binary runs inside the container, and the container never gets the Docker socket ([decision 0016](0016-one-docker-container.md)). So `aphelion` can't run Docker itself in production.

## Options

### The parser

The follow-up comparison compiled prototypes of all seven commands with `bun build --compile` on Bun 1.4.5. The sizes below show the approximate increase over a Bun binary that loads Zod. The first comparison used a smaller `parseArgs` prototype that omitted Zod. The follow-up prototypes had no server code, and their source was discarded, so the figures give only a rough sense of size.

| Option | Added size | For | Against |
| --- | --- | --- | --- |
| **Node's `parseArgs`**, from `node:util` | 8 KB | Bun provides it without a new dependency. The plugin runner already uses it. Aphelion uses Zod to validate values and controls what goes into usage errors. | Aphelion maintains the command table, help text, and usage checks in `args.ts` and `help.ts`, about 245 lines total. |
| Effect's CLI module, `effect/cli` 4.1.5 | 582 KB (213 KB over a prototype that already loads Effect) | Already installed. Generates help and lets Aphelion disable extra global options. Its mapping hooks can call Zod. | The prototype echoed invalid input, accepted an empty `--compose` value, and returned exit code 1 for usage errors. It needed code to match Aphelion's behavior. |
| Optique 1.4.0 | 455 KB | The prototype rejected duplicate and misplaced options and used the existing [Zod schemas directly](https://optique.dev/integrations/zod). | Adds `@optique/core` and `@optique/zod`. Aphelion would still need to filter error messages and preserve its help and exit-code behavior. |
| Commander 15.1.0 | 74 KB | Generates help and can call Zod through option hooks. | Adds a dependency. The prototype needed Aphelion code for most of its usage rules, including filtering error messages and rejecting repeated options. |

Keep `parseArgs` for this command set. The existing command table and tests already cover the behavior Aphelion needs, including usage errors that omit pasted tokens. Optique would remove more of that code than the other alternatives, at the cost of two new packages and a custom error filter.

### The Compose output

| Option | For | Against |
| --- | --- | --- |
| **`config check --compose -` reads it from standard input, and `--compose FILE` from a file** | Works with the binary in the container: Docker runs on the host and pipes its output in. Nothing in the container needs Docker | The host needs the right command line. M0-12's host script and install guide carry it |
| `aphelion` runs `docker compose config` itself | One command to type | Fails in the container, which has no Docker. Works only with a second copy of the binary installed on the host, which no plan includes |

## Decision

- **Node's `parseArgs`** reads the command line. `args.ts` turns it into one command, and refuses an unknown command, an option the command doesn't use, or a wrong value, with exit code 2.
- **Effect runs the commands.** It does the parts where it helps: it stops the server on `SIGTERM` or `SIGINT`, closes the database whatever happens, and turns a failure into an exit code. `@effect/platform-bun`'s `runMain` does the first, from `apps/server/src/adapters/run-main.ts`.
- **`config check --compose -`** reads the output of `docker compose config` from standard input. The host runs:

  ```sh
  set -o pipefail
  docker compose --profile '*' config \
    | docker compose run --rm -T --user harness aphelion aphelion config check --compose -
  ```

- **`config check` also checks the state folder**, `/var/lib/aphelion`, as [decision 0014](0014-filesystem-layout.md) asks: a folder owned by the server's user and group, mode `0700` or tighter. `--headless` runs the same checks and doesn't start when one fails. The bot and secrets folders belong to other users, and [#14](https://github.com/jcore9/Aphelion/issues/14) checks them when it creates those users.
- **`device list` and `device revoke ID`** join `device add`. #98 asks for revocable tokens, and the owner needs the id to revoke one.

[The `aphelion` command reference](../reference/cli.md) lists every command, option and exit code.

## Consequences

- No new package. The help text is written by hand, and a test checks that each command appears in it.
- M0-12 ([#14](https://github.com/jcore9/Aphelion/issues/14)) puts the Compose check command in its host script, and runs `aphelion` commands as `harness` (`--user harness`) with `-T`, so the database files keep their owner and the token stays alone on standard output.
- The server exits with code 130 after `docker stop`, so `docker ps -a` shows `Exited (130)` for a normal stop.
- Revisit if maintaining the command table and help text becomes costly, or if the CLI needs interactive prompts or shell completion. Compare Optique and `effect/cli` against the CLI's usage and error rules at that point.
