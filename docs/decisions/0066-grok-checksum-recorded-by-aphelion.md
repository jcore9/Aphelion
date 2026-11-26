# 0066. Aphelion records its own checksum for Grok Build, because xAI publishes none

- Status: Proposed
- Date: 2026-11-25
- Decided by: project owner
- Proposed by: [#155](https://github.com/jcore9/Aphelion/issues/155), the AI tool list
- Answers: how a Grok Build version enters the AI tool list
- Amends: [0063](0063-m1-planning-answers.md), whose rule 4 says each new tool version is checked against the vendor's own checksum

## Context

[Decision 0063](0063-m1-planning-answers.md) says each pull request that bumps a tool in `deploy/ai-tools.json` checks the new checksum against the vendor's own. A **checksum** is a SHA-256 fingerprint of a file. If one byte of the file changes, the fingerprint changes.

Three of the four tools publish a checksum that the bump can check against:

- Claude Code publishes a signed `manifest.json` for each version.
- Codex shows a SHA-256 digest for each file of a GitHub release.
- OpenCode publishes a `SHA256SUMS` file with each release.

Grok Build publishes none. It serves one file per version and processor from two addresses, `https://x.ai/cli` and `https://storage.googleapis.com/grok-build-public-artifacts/cli`.

The owner answered on 2026-11-25: "Grok Build publishes no checksum. Aphelion records its own: the bot downloads the pinned file from both of xAI's hosts, checks that the two copies match, and records that SHA-256. The owner approves it like any list change. Every later install must match."

## Options

| Option | For | Against |
| --- | --- | --- |
| Leave Grok Build off the list until xAI publishes a checksum | Every entry has a vendor checksum. | The owner can't install Grok Build from the list, and M4 needs it. |
| Record a checksum without comparing hosts | Simple. | One bad download becomes the pinned value. |
| Record a checksum that two xAI hosts agree on | The pinned value doesn't come from one transfer. Every later install is checked against it. | The fingerprint proves less than a vendor checksum. See below. |

## Decision

The third option.

1. For a Grok Build entry, `checksumSource` is `recorded`. `scripts/verify-ai-tools.ts` downloads the version from both hosts, requires the two files to have the same SHA-256 and size, and prints that value for the list.
2. The bump pull request pastes the script's output. The owner approves the pull request like any list change.
3. `aphelion tool install grok` refuses any download whose SHA-256 differs from the list's.
4. This amends rule 4 of 0063 for Grok Build only. The other three tools keep the vendor-checksum rule.

**What the recorded fingerprint proves.** The file that `tool install` downloads is the same file the owner approved. If someone swaps the file at xAI's address later, the install refuses it.

**What it doesn't prove.** It doesn't prove that the first copy came from xAI. A bad file that both hosts served at the moment of the check would be recorded as good. The two hosts also look like one store behind two front doors: both answered with the same Google Cloud Storage headers and the same entity tag. So their agreement rules out a faulty transfer or a faulty cache. It doesn't show that two independent sources agree. The install guide says this.

## Consequences

- #155 ships Grok Build 1.0.92 with the values the script printed.
- A Grok Build bump costs the bot two downloads of about 200 MB and an owner approval, the same approval any bump needs.
- Revisit this record when xAI publishes a checksum or a signature for Grok Build. Then the entry moves to a vendor source and `recorded` is removed.
