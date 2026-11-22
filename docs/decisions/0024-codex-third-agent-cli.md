# 0024. Codex CLI becomes a third agent CLI, spiked in M0 and built in M4

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner
- Amends: the plan's goal "starting with Claude Code and Grok Build" and its architecture diagram (provider APIs), [0019](0019-cli-subscription-use.md) (adds Codex on a ChatGPT login), [0022](0022-agent-network-boundary.md) (the egress allowlist in option 2), and the [M0 plan](../plan/milestones/M0-foundations.md) (adds M0-17)

## Context

The plan drives AI CLIs through one adapter interface, "starting with Claude Code and Grok Build". The owner wants OpenAI's Codex CLI as a third, driven by Aphelion agents the same way as the other two. The owner gave these answers on 2026-11-21:

1. Codex is a third agent CLI that Aphelion agents drive, the same way they drive Claude Code and Grok Build.
2. A written spike runs in M0 now, like M0-01 and M0-02. The real Codex support is built in a later milestone, after the Claude and Grok adapters work.
3. Codex signs in with the owner's own ChatGPT subscription, as in decision 0019. No API billing.

What isn't known yet is what M0-01 and M0-02 answered for the other two CLIs: which headless path works, whether it runs on a subscription login, and whether the terms allow it. Codex also gates by sandbox first: with its `on-request` approval policy, commands that the sandbox allows run without asking. Aphelion's approval model needs a permission request for every tool call (M2-04). The spike, [M0-17](https://github.com/jcore9/Aphelion/issues/113), answers these questions. This record doesn't assume the answers.

## Options

1. Stay at two CLIs, Claude Code and Grok Build.
2. Add Codex now, in M1, beside the Claude adapter.
3. Spike Codex in M0 now, and build the adapter after the Claude and Grok adapters work.

## Decision

Option 3.

- **The spike.** [M0-17](https://github.com/jcore9/Aphelion/issues/113), "Spike: Codex headless on a ChatGPT login", joins M0 wave 1. It depends on M0-00 only and blocks nothing inside M0.
- **The build.** [M4-10](https://github.com/jcore9/Aphelion/issues/114), "Codex adapter plugin", sits in M4 next to the Grok adapter (M4-01). It depends on M1-01 and M0-17. M4-09 was already taken by agent management tools (#91), so the adapter is M4-10.
- **The account.** Codex runs on the owner's own ChatGPT login, under the guardrails in [0019](0019-cli-subscription-use.md):
  - Aphelion runs the official, unmodified `codex` binary, and the official ACP adapter if the spike picks one, at pinned versions.
  - The owner signs in with Codex's own flow (`codex login`), run as `aphelion-agent` inside the container. Aphelion never asks for, reads, copies, logs or transmits the token file.
  - Aphelion uses one person's own subscription, and never routes it on behalf of other people.
  - An API key per agent stays possible through the secrets broker, for anyone who wants it.
- **Not decided here.** The headless path, whether every tool call can be made to ask, whether the managed config holds, whether the owner's plan includes the CLI, and whether OpenAI's terms allow it. M0-17 answers each one. A "no" or an unclear answer stops for the owner, as the earlier spikes did.

## Consequences

The Codex work touches these issues. The last column names the M0-17 question that decides the change.

| Issue | Change | Decided by |
| --- | --- | --- |
| [M0-17](https://github.com/jcore9/Aphelion/issues/113) | New spike in M0 wave 1. | None |
| [M4-10](https://github.com/jcore9/Aphelion/issues/114) | New issue: the Codex adapter plugin. It speaks ACP through `codex-acp`, or app-server JSON-RPC directly. | Questions 1, 2 and 8 |
| [M0-12](https://github.com/jcore9/Aphelion/issues/14) | No change in M0. M4-10 adds the pinned `codex` binary, the auto-update setting and a root-owned `/etc/codex/requirements.toml` to the image. | Questions 6 and 7 |
| [M1-01](https://github.com/jcore9/Aphelion/issues/19) | No change expected. The contract's events already cover text, tools, permission requests, turn end, errors and usage. If Codex can't fit them, M4-10 proposes a contract change. | Questions 1 and 5 |
| [M1-07](https://github.com/jcore9/Aphelion/issues/25) | M4-10 adds a recorded Codex stream to the contract tests. | Question 1 |
| [M2-04](https://github.com/jcore9/Aphelion/issues/30) | Codex permission requests go to the policy engine. If Codex can't ask for every tool call, the owner decides whether a sandbox-based policy is acceptable for Codex. | Question 5 |
| [M2-05](https://github.com/jcore9/Aphelion/issues/31) | Ships for Claude and Grok as planned. M4-10 adds the Codex managed hook, which calls the same engine socket. | Question 6 |
| [M4-08](https://github.com/jcore9/Aphelion/issues/51) | No change. The v0.1 end-to-end test stays Claude and Grok, so Codex doesn't hold up v0.1. A Codex leg can join after M4-10 lands. | None |
| M7 | A Codex collector, filed when M7 is planned ([M7-00](https://github.com/jcore9/Aphelion/issues/74)). App-server has `account/rateLimits/read`. The spike says whether those windows reach Aphelion through the adapter. [M7-01](https://github.com/jcore9/Aphelion/issues/75) needs no change, and [M7-04](https://github.com/jcore9/Aphelion/issues/78) shows a third provider. | Question 8 |
| [0022](0022-agent-network-boundary.md) option 2 | The egress allowlist adds the OpenAI hosts that Codex needs. | Question 7 |
| Install guide (M0-12, then M4-10) | Covers signing in to Codex inside the container, and states the one-person rule. | Question 7 |

- The M0 plan gains M0-17, a fourth spike, a risk row, and a ChatGPT login on the spike VM.
- If M0-17 finds that Codex can't run here on these terms, this record is revisited, and M4-10 is closed or changed.
