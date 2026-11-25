# 0019. Bots run the Claude and Grok CLIs on the owner's own subscription logins

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner
- Answers: M0-01 question 3 and M0-02 question 4
- Amended by: [0034](0034-vendor-protocol-per-cli.md) (the first guardrail names no ACP adapter; each CLI runs through its vendor's own protocol)
- Amended by: [0035](0035-codex-login-sandbox-approvals.md) (Codex joins on a ChatGPT login under these guardrails)

Corrected on 2026-11-24: the Claude command is `claude auth login` ([M0-24 finding](../spikes/M0-24-sign-in-from-the-app.md)).

## Context

M0-01 and M0-02 confirmed that both CLIs run headless on a subscription login with no API key. Neither vendor's published terms address one person running their own copy of an open-source tool. The plan said a spike that found the terms unclear would stop and ask the owner. The quotes are in the [M0-01 finding](../spikes/M0-01-claude-over-acp.md) and in the M0-02 finding ([#3](https://github.com/jcore9/Aphelion/issues/3)).

## Options

1. Proceed on the owner's subscription logins, with guardrails that keep Aphelion on the end-user side of the vendors' rules.
2. Require API keys for both providers.
3. Ask each vendor for written confirmation first.

## Decision

Option 1. The owner's position is that both vendors allow their CLIs to be driven this way, as other self-hosted tools such as T3 Code already do.

Guardrails, which hold even if the vendors' wording changes:

- **Unmodified binaries.** Aphelion runs the official, unmodified `claude` and `grok` CLIs, and the official ACP adapter, at pinned versions. It never patches them.
- **Sign-in through the vendor's own flow.** The owner signs in with `claude auth login` and `grok login`, run as `aphelion-bot` inside the container. Aphelion never asks for, reads, copies, logs or transmits the CLIs' tokens. The CLIs keep their own credential files in the bot user's home, and the broker doesn't hold them.
- **One person's own subscription.** Aphelion is self-hosted by the person whose subscription it uses. It never routes one person's login on behalf of other people, and the docs say so.
- **API keys stay possible.** Each provider can be switched to an API key per bot, through the secrets broker, for anyone who wants it.

## Consequences

- M1-02 and M4-01 go ahead on subscription logins.
- The install guide (M0-12) covers signing in to each CLI inside the container, and states the one-person rule.
- If a vendor publishes wording that rules this out, this record is revisited, and that provider's bots switch to API keys.
- Usage comes from the subscriptions' own windows (M7), shared with the owner's other use of Claude and Grok.
