# 0049. The container image ships no AI tool, and the owner installs AI tools from a list

- Status: Accepted (approved by merging #156 on 2026-11-23)
- Date: 2026-11-22
- Decided by: project owner
- Proposed by: the container image PR ([#14](https://github.com/jcore9/Aphelion/issues/14))
- Amends: [decision 0016](0016-one-docker-container.md) (what the image contains), the M0 plan's M0-12 note, and issue [#14](https://github.com/jcore9/Aphelion/issues/14)
- Amended by: [0060](0060-server-stays-on-linux-with-api-keys-and-two-plugin-fixes.md) (one checksum per architecture, x86-64 and arm64)

## Context

[Decision 0016](0016-one-docker-container.md) and issue #14 put pinned versions of Claude Code and Grok Build into the container image. While #14 was being built, the owner said that the container must not assume which AI provider the user wants.

An AI tool here means a command-line program that a bot drives, such as Claude Code, Codex, Grok Build or OpenCode.

## Options

The owner chose from three options on 2026-11-22:

| Option | For | Against |
| --- | --- | --- |
| Ship no AI tool in #14, and build the list in a new issue | #14 stays about the container, the users and the host setup. The list gets its own security review. | No bot can run in the container until the new issue lands. |
| Ship no AI tool, and build the list in #14 | Everything lands at once. | #14 is already a large `risk/security` PR, and the install path adds code that downloads programs. |
| Keep Claude Code and Grok Build in the image for now | Matches #14 as written. | The image picks two providers for every user, and the image is about 850 MB larger. |

## Decision

The first option.

- The image from #14 contains no AI tool. The contract test fails if `claude`, `codex`, `grok` or `opencode` is on the image's path.
- Issue [#155](https://github.com/jcore9/Aphelion/issues/155) builds the list. Aphelion keeps a list of common AI tools, each with a pinned version and a checksum. The owner installs the tools they want from that list.

## Consequences

- The image is 781 MB, down from 1.63 GB with the two tools.
- [M1-02](https://github.com/jcore9/Aphelion/issues/20), the first bot adapter, needs #155 before it can run a bot in the container. [M4-01](https://github.com/jcore9/Aphelion/issues/44) and [M4-10](https://github.com/jcore9/Aphelion/issues/114) need it for Grok Build and Codex.
- The managed settings and hooks for each tool, which 0016 bakes into the image under `/etc/claude-code/` and `/etc/grok/`, move with each tool. [M2-05](https://github.com/jcore9/Aphelion/issues/31) decides where they live once the tools are installed from the list.
- The [M0-02 finding](../spikes/M0-02-grok-headless-billing.md) asked #14 to turn off Grok's auto-update in the image. That moves to #155.
