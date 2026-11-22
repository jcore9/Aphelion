# 0028. The policy engine runs inside the harness for v1

- Status: Accepted
- Date: 2026-11-21
- Decided by: plan of record (imported in [0004](0004-import-plan-with-m0-plan.md))
- Answers: the plan's Open decisions, "Where the policy engine runs"

## Context

The policy engine decides every gated action. Its inputs are ACP permission requests and hook callbacks. It applies static rules, then the reviewer, then asks you, and it logs every decision. Agents must not be able to reach or change it.

## Options

| Option | For | Against |
| --- | --- | --- |
| Inside the harness, under the harness's own Unix user | Exists from M2, before any gateway host. Agents can't write to the harness's files. | Shares a machine with the agents |
| On the gateway host | Further from the agents, next to the credentials | The gateway doesn't exist until M3 |

## Decision

The policy engine runs inside the harness for v1. It moves next to the gateway once connectors land.

## Consequences

- M2 builds the policy engine in the server.
- [Decision 0016](0016-one-docker-container.md) runs the harness as the `harness` user inside the server container, so the engine stays out of reach of `aphelion-agent`.
- No issue in the Issue breakdown moves the engine yet. The gateway arrives with M3-01, and the issue that moves the engine is filed after it.
