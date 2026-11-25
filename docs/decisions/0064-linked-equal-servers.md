# 0064. Two or more Aphelion servers can link up as equals, with groundwork in M1 and the build after v1.0

- Status: Proposed
- Date: 2026-11-25
- Decided by: project owner
- Proposed by: [#18](https://github.com/jcore9/Aphelion/issues/18), the M1 milestone plan
- Answers: whether Aphelion runs on more than one server, and what M1 must do now to allow it
- Amends: the [M1 plan](../plan/milestones/M1-one-bot-end-to-end.md), which gains the groundwork below

## Context

The owner wants to run two or more Aphelion servers that link up as equals. Each server is complete on its own. The owner connects to either one, both show all bots, and the owner picks which server a bot runs on. Chat history, approvals and settings stay in step between them.

Until now Aphelion assumes one server. Tables count rows 1, 2, 3, so two servers would give different rows the same number. A design that ignores this makes linking much harder later.

Terms used below:

- A **server ID** is a name for one server that never changes after its first start.
- A **UUIDv7** is a random ID that also sorts by creation time. Two servers don't produce the same one.
- A **spike** is a written study that answers questions before anything builds on them.

## Options

The owner weighed three shapes.

| Option | For | Against |
| --- | --- | --- |
| One main server with helpers | Simple. One place holds history, approvals and settings. | The main server is a single point of failure. The helpers can't work alone. |
| Equal servers that link up (chosen) | Each server works alone. Either one can be the one the owner connects to. | The servers must keep history, approvals and settings in step, and must trust each other. |
| Apps connect to both, and the servers don't link | No sync to build. | The owner sees two separate sets of bots, history and approvals. A bot can't move. |

The owner also chose when to build it.

| Timing | For | Against |
| --- | --- | --- |
| Build it in v1 | The feature arrives early. | It delays M1 to M8, and the design isn't studied yet. |
| Groundwork now, build after v1.0 (chosen) | M1 stays small and nothing in it blocks linking. | The feature waits. |
| No groundwork | M1 is a little smaller. | Every table that counts rows 1, 2, 3 needs a migration later. |

## Decision

Aphelion will support equal linked servers. The timing is:

1. **M1 groundwork.**
   - Each server gets a stable server ID on first start. It is stored in its database.
   - The new tables from message history ([#23](https://github.com/jcore9/Aphelion/issues/23)), and any other new table in M1, use IDs that can't clash between servers, such as UUIDv7. They don't count 1, 2, 3.
   - Each saved record names the server that wrote it.
   - Existing tables stay as they are. The audit log, `audit_log`, uses integer IDs. Moving it to IDs that can't clash is a known migration for later.
2. **M4: a design spike on linking equal servers.** It answers four questions. How do history, approvals and settings stay in step? How do the servers trust each other over Tailscale? What happens when one server is offline? How is a bot placed on a server?
3. **After M8: its own milestone** builds the feature.

## Consequences

- #23 and any new M1 table carry the ID rule and the writer column. The [M1 plan](../plan/milestones/M1-one-bot-end-to-end.md) says so and lists the risk.
- The bot runner already sits behind one message channel ([#22](https://github.com/jcore9/Aphelion/issues/22)). A bot on another server would use the same channel, so M1 adds nothing for it.
- The orchestrator files the M4 spike and a placeholder for the later milestone. The project plan's milestone list stays unchanged for now.
- Revisit this record when the M4 spike reports.
