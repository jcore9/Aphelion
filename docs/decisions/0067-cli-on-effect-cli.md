# 0067. The aphelion command reads its command line with effect/cli, and a test pins the usage rules

- Status: Proposed
- Date: 2026-11-25
- Decided by: project owner
- Proposed by: [#241](https://github.com/jcore9/Aphelion/issues/241), the command line on `effect/cli`
- Answers: whether the server's command keeps the hand-written parser from decision 0048
- Amends: [0048](0048-cli-on-node-parseargs.md). This record replaces its parser part. The part about Compose output on standard input stays.

## Context

[Decision 0048](0048-cli-on-node-parseargs.md) chose Node's `parseArgs` plus a command table and help text that Aphelion maintained in `args.ts` and `help.ts`, about 480 lines once the `tool` commands arrived ([#155](https://github.com/jcore9/Aphelion/issues/155)). It left the door open: revisit if the table becomes costly. [Decision 0041](0041-effect-in-server-and-cli.md) says the server and the command use the Effect library, and that Zod validates values.

On 2026-11-25 the owner decided to move the command to `effect/cli` and to keep Zod as the only validator. `effect/cli` is part of the `effect` package the server already uses. It is marked unstable, so its text and error behavior can change in any release.

## Options

A research pass ran a prototype against `effect` 4.1.5 and Bun 1.4.5. It compared `effect/cli` with 0048's findings.

| Rule from 0048 | `effect/cli` out of the box | What Aphelion adds |
| --- | --- | --- |
| A usage error exits 2 | Exits 1 | One catch that turns every usage error into exit 2 |
| An error never repeats the input | Repeats the input in five error types | A presenter that prints fixed text for each error type, and only option names that match `-` and lowercase letters |
| An empty value is refused | Accepts `--compose ''` | One helper on every string flag |
| `device add` prints only the token on standard output | Prints help on standard output before an error | The same presenter writes every error to standard error |
| Zod checks values | Accepts only its own Schema library | Each flag and operand runs a Zod schema inside `Flag.mapTryCatch` or `Argument.mapTryCatch` |

The code for those five rules is `flags.ts` and `output.ts`, about 210 lines. Each command also gets a `Command.make` with its description in its own file. Together they replace `args.ts` and `help.ts` (480 lines), whose table had to match the handlers by hand. The compiled binary grew by 196,608 bytes, from 110,590,128 to 110,786,736.

## Decision

- **`effect/cli` reads the command line.** `cli/index.ts` builds the command tree from a `makeCli(handlers)` function. Each command is defined in the file of its handler. A test passes recording handlers and checks the parsed values.
- **Zod checks every flag value.** Plugin ids and folders are passed through as today. `flags.ts` runs a Zod schema inside the mapping hooks and turns a Zod failure into the sentence the old parser printed. The Zod schemas in `devices/` and `tools/` don't change. Effect Schema stays out.
- **The usage rules of 0048 hold, with the same sentences.** A usage error exits 2, prints two lines on standard error, and never repeats a value you typed. It may name an option or command Aphelion knows, or a plain lowercase word such as `--nope`. `--no-headless` and any argument that starts with a single dash, other than `-h` and `-v`, are usage errors, because `effect/cli` would read `-abc` as three short flags. An empty value, an option the command doesn't use and an option given twice are errors.
- **A test pins those rules.** `cli/usage-contract.test.ts` checks exit code 2, that a canary token typed into every kind of error never appears in the output, that empty values are refused, the `--version` text, and that `device add` prints only the token. It runs on every pull request. A pull request that bumps `effect` fails there if `effect/cli` changed any of it.
- **Bun-only imports stay in `adapters/`.** `adapters/run-main.ts` exports the Bun services layer that `effect/cli` needs.

## What changes for a user

- **Help.** `aphelion --help` lists the four command groups. `aphelion device --help` lists the commands in a group, and `aphelion device add --help` shows that command's options with their defaults. There is no longer one long page.
- **Options go after the command.** `aphelion --state-dir /s device list` now fails with `--state-dir isn't an option of "device"`. Write `aphelion device list --state-dir /s`. The reference page and every script in `deploy/` already use that order.
- **`-v` prints the version**, like `--version`.
- **`aphelion --version --headless` prints the version** instead of failing.

## Consequences

- The command table and the help text are gone. A new command is one `Command.make` beside its handler and one line in `index.ts`.
- 0048's other part stays: `config check --compose -` reads Compose output from standard input.
- Revisit when `effect/cli` leaves unstable status, or if the usage-contract test fails after a release in a way the presenter can't absorb.
