# 0027. Agent adapters speak ACP first, with stream-json as a fallback per provider

- Status: Accepted
- Date: 2026-11-21
- Decided by: plan of record (imported in [0004](0004-import-plan-with-m0-plan.md))
- Answers: the plan's Open decisions, "Adapter protocol"

## Context

Aphelion drives several AI CLIs through one adapter interface. Each adapter turns a CLI's output into one normalized event type: text delta, tool start and end, permission request, turn end, error and usage. Two ways to talk to the CLIs existed when the plan was written:

- The [Agent Client Protocol](https://agentclientprotocol.com/) (ACP), a JSON-RPC protocol over stdio. Grok Build speaks it as `grok agent stdio`, and Claude Code speaks it through an ACP adapter.
- Each CLI's own streaming output, such as Claude's `-p --output-format stream-json` with `--resume`.

## Options

| Option | For | Against |
| --- | --- | --- |
| ACP first, stream-json as a fallback per provider | One protocol for every CLI. Permission requests arrive as protocol messages, so the policy engine sees them. | Depends on an adapter for Claude. A provider whose ACP support breaks needs the fallback. |
| Native stream-json for each CLI | No adapter between Aphelion and the CLI | One parser per CLI, and permission handling differs per CLI |

## Decision

ACP first. Each provider can switch to its native streaming output as a fallback, behind the same adapter contract.

## Consequences

- M1-02 builds the Claude adapter on ACP, and M1-03 builds the stream-json fallback, switchable per agent.
- M4-01 builds the Grok adapter on `grok agent stdio`.
- The M0-01 and M0-02 spikes found that both CLIs run a full ACP turn with tool calls on a subscription login ([M0-01 finding](../spikes/M0-01-claude-over-acp.md), [M0-02 finding](../spikes/M0-02-grok-headless-billing.md)).
- [Decision 0024](0024-codex-third-agent-cli.md) leaves the Codex transport to its spike: ACP through `codex-acp`, or app-server JSON-RPC directly.
