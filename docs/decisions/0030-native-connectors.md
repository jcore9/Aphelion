# 0030. Connectors are native, starting with GitHub

- Status: Accepted
- Date: 2026-11-21
- Decided by: plan of record (imported in [0004](0004-import-plan-with-m0-plan.md))
- Answers: the plan's Open decisions, "Connector gateway"

## Context

Agents reach third-party services only through the connector gateway, which holds the credentials. The plan's Native connectors section designs the connector interface: a manifest with a risk class per tool, an auth flow, an encrypted credential store, tool handlers, an optional event source, and a policy per tool.

## Options

| Option | For | Against |
| --- | --- | --- |
| Native connectors | Each tool declares its risk class and the exact provider permission it needs. Results are trimmed and typed. Credentials never leave the gateway. | Each service needs its own connector |
| An off-the-shelf MCP proxy, such as hoophq mcpproxy or Arbitus | Many services at once | Less control over scopes, risk classes and results. Another project's security model in the trust path. |

## Decision

Native connectors, GitHub first. Custom MCP servers that you add run behind the same gateway, and every call passes the policy engine.

## Consequences

- M3 builds the connector framework and the GitHub App connector. M8 adds Forgejo, Notion and Gmail on the same framework.
- [Decision 0018](0018-shared-plugin-user.md) runs connector plugins under the plugin runner, and the connectors that move to the gateway host in M3 use the same runner there.
