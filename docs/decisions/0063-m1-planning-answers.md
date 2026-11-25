# 0063. Before M2 approvals, the first bot works in its own folder, and M1 takes four other choices

- Status: Accepted
- Date: 2026-11-25
- Decided by: project owner
- Proposed by: [#18](https://github.com/jcore9/Aphelion/issues/18), the M1 milestone plan
- Answers: the open questions in the [M1 plan](../plan/milestones/M1-one-bot-end-to-end.md)
- Amends: [0049](0049-ai-tools-installed-from-a-list.md), which now has a maintainer for its list, and [0060](0060-server-stays-on-linux-with-api-keys-and-two-plugin-fixes.md), which now says which of a key and a sign-in wins

## Context

M1 builds the first bot. The approvals system comes in M2, so M1 needs a fixed rule for what the bot may do. M1 also needs answers on sign-in against API key, how the installer gets the image, who keeps the AI tool list, and what a restore does to plugins. The owner answered these on 2026-11-25, while reviewing the M1 plan.

Terms used below:

- A **permission request** is Claude Code asking the program that drives it whether a tool call may run. In the Claude Agent SDK, Anthropic's library for driving Claude Code, the `canUseTool` function answers it.
- A **digest** is a fingerprint of a file or an image. If one byte changes, the digest changes.
- **arm64** is the processor design of Apple Silicon, the Raspberry Pi 5 and many cloud servers. **x86-64** is the design in most PCs.
- An **owner path** is a path that `CODEOWNERS` names. A pull request that changes one waits for the owner ([decision 0062](0062-one-main-branch.md)).

## Options

| Question | Options | Chosen |
| --- | --- | --- |
| What may the first bot do before M2? | Chat only, with no tools. Files and shell commands in its own folder. Everything, with no checks. | Files and shell commands in its own folder. |
| Which wins when a bot has a sign-in and an API key? | The sign-in. The key. A per-bot setting from day one. | The sign-in. |
| How does the installer get the image? | Always build on the server. Always download. Download, and build as a fallback. | Download, and build as a fallback. |
| Who keeps the AI tool list? | The bot changes it like any file. The list becomes an owner path. | An owner path. |
| What does a restore do to plugins? | Plugins run as before. Plugins keep their files and start switched off. | Switched off. |

## Decision

1. **The first bot may read and write files in its own working folder and run shell commands there.** Aphelion's fixed answer to every permission request, in the `canUseTool` function of [#20](https://github.com/jcore9/Aphelion/issues/20), does three things.
   - It allows the file tools for paths inside the bot's folder.
   - It denies the file tools for paths outside it.
   - It denies Claude's web tools.

   The answer never changes with the request, and it never returns a session-wide rule or a mode change.

   **The limit, which the owner accepted.** Aphelion cannot read what a shell command does. Only two things hold a shell command: the file permissions of the `aphelion-bot` account, and the container. A command can read other bots' folders. Only one bot exists in M1, so there are none to read. A command can also reach the internet. The container still keeps it from Aphelion's secrets and config. The docs say this plainly. M1 uses test data only. M2 puts each command behind the owner's yes or no.
2. **A subscription sign-in wins over an API key.** When a bot has both, Aphelion uses the key only when no working sign-in exists. A per-bot setting can come with the bot registry in M4. This is recorded in [#181](https://github.com/jcore9/Aphelion/issues/181).
3. **The installer downloads a ready-made image.** A GitHub workflow builds the image for each release, for x86-64 and arm64. The installer checks the digest of what it downloaded. If the download fails, it builds the image on the server, as it does today. The workflow lives in `.github/`, an owner path.
4. **The AI tool list ([#155](https://github.com/jcore9/Aphelion/issues/155)) becomes an owner path in `CODEOWNERS`.** For each new version of a tool, the bot opens a pull request. The pull request verifies the new checksum against the vendor's own download, and the owner approves it.
5. **After a restore, plugins keep their files and settings but start switched off.** The owner switches each one back on. This is already in [#199](https://github.com/jcore9/Aphelion/issues/199). Every device enrolls again, as the owner decided on 2026-11-24 ([#144](https://github.com/jcore9/Aphelion/issues/144)).

Two earlier owner decisions carry into M1. The owner's own live check of API keys uses a throwaway test key with a small spending limit, and automated tests use fake keys ([#181](https://github.com/jcore9/Aphelion/issues/181)). Startup refuses ufw with `MANAGE_BUILTINS=yes` ([#191](https://github.com/jcore9/Aphelion/issues/191)).

## Consequences

- #20 carries the fixed permission answer and its tests. #181 carries the sign-in rule. #178 is split, and one part builds the image workflow ([the M1 plan](../plan/milestones/M1-one-bot-end-to-end.md#splits)). #155 adds its list to `CODEOWNERS`. #199 already holds answer 5.
- A prompt-injected bot can reach the internet and run any command its account may run. The threat model and the install guide say so, and M1 holds no real secrets or private data.
- Releases get slower by one workflow run, and the installer gets a second path to test.
- Revisit answer 1 when M2 ships approvals. Revisit answer 2 when the bot registry lands in M4.
