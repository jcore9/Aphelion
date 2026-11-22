# 0048. The aphelion command reads its command line with Node's parseArgs, and Docker's Compose output reaches config check through standard input

- Status: Proposed
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

An exploratory measurement, with Bun 1.4.5 and `effect` 4.1.5 on the dev box. Each stub was a one-file program with the same commands (`--headless`, `config check --compose`, `device add NAME --days N`) and no server code. The `effect/cli` stub ran under `BunRuntime.runMain` with `BunServices.layer`. Each was compiled with `bun build --compile stub.ts --outfile stub`, and the time is the mean of 20 runs of `stub --version`. The stubs weren't kept, so treat the numbers as a rough guide.

| Option | Binary size | `--version` | For | Against |
| --- | --- | --- | --- | --- |
| **Node's `parseArgs`**, from `node:util`, with a short table of commands | 109,209,776 bytes | 8 ms | Built into Bun and Node, marked stable, no new package. The plugin runner already uses it (`apps/server/src/plugins/runner-main.ts`). Values are checked with the same Zod schemas that `addDevice` uses | The help text and the command table are written by hand, about 245 lines in `args.ts` and `help.ts` |
| Effect's CLI module, `effect/cli` | 109,775,024 bytes | 53 ms | Generates help, typed flags and subcommands. Already installed with `effect` | Marked `@stability unstable` in 4.1.5, so its API may change in a minor release. Adds global flags that Aphelion doesn't want: `--wizard` (interactive prompts), `--completions` and `--log-level`. They can be turned off through `CliConfig`. Its value checks are built on Effect `Schema`. Zod can still be called through its mapping hooks, but that is extra glue on every flag |
| `commander`, or another parser package | not measured | not measured | Widely used | A new dependency for the server binary, and one more package to vet, with nothing that `parseArgs` lacks for five commands |

The finished binary, with the server code, is 110,201,008 bytes, and `aphelion --version` takes 67 ms. A difference of tens of milliseconds doesn't matter for commands that run a few times a day, so start time doesn't decide the question. The unstable API and the unwanted flags do.

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
- Revisit if the command grows to many subcommands, or needs interactive prompts or shell completion. `effect/cli` is the first candidate then, once it is marked stable.
