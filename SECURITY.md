# Security policy

## Report a vulnerability

Report it privately through GitHub's private vulnerability reporting. Open [the repo's Security tab](https://github.com/jcore9/Aphelion/security) and select **Report a vulnerability**, or go straight to [a new advisory](https://github.com/jcore9/Aphelion/security/advisories/new).

Never report a vulnerability in a public issue, a pull request or a discussion.

Include what you found, the steps to reproduce it, and the commit or version you tested.

## Supported versions

Aphelion is pre-alpha. The latest release is `v0.1.0-alpha.1`. Fixes land on `main` and ship in the next release.

## In scope

Aphelion assumes that every bot can be prompt-injected. Enforcement lives outside the bots' reach. A report is in scope when something gets past that enforcement, for example:

- A bot, or a plugin, reads or changes what its Unix user shouldn't reach: the server's config, the database, the secrets store, the approval rules or the managed CLI hooks.
- A tool call or connector call runs without the approval that the policy requires.
- Code escapes the container's hardening, such as the read-only root filesystem, the dropped capabilities or `no-new-privileges`.
- The server API or its WebSocket accepts a request without a valid device token. The only exception is `/health`.
- A secret or a CLI login token ends up in a log, an event or a client.
- The bot runner or the secrets broker accepts a caller it should refuse.
- The install docs or the Compose file publish the server beyond the tailnet address.

## Out of scope

- Bugs in the Claude Code, Grok Build and Codex CLIs, Docker or Tailscale themselves. Report those to their vendors. A way that Aphelion's use of them weakens its own enforcement is in scope.
- A bot that misbehaves inside its own workspace while the approval layer gates it as designed.
- Attacks that need root on the host, or a compromised client device that still holds a valid token.
