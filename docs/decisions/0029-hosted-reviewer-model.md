# 0029. The reviewer is a small hosted model, called with an API key

- Status: Accepted
- Date: 2026-11-21
- Decided by: plan of record (imported in [0004](0004-import-plan-with-m0-plan.md))
- Answers: the plan's Open decisions, "Reviewer model"

## Context

The reviewer gives a second opinion on risky calls when no static rule matches. It is a separate model call that sees only the tool and its arguments, never the content that triggered the call, and it has no tools of its own. It can only release low-risk calls.

## Options

| Option | For | Against |
| --- | --- | --- |
| A small hosted model, called with an API key | No hardware to run. Fast to set up. | An API key and a per-call cost. The arguments leave the machine. |
| A local model on your own GPU | Arguments stay local, with no per-call cost | Needs a GPU and model upkeep, before the rules are stable |

## Decision

A small hosted model. Revisit a local model once the rules are stable.

## Consequences

- M8-01 builds the reviewer plugin with a configurable model and configurable releasable risk classes.
- [Decision 0019](0019-cli-subscription-use.md) covers the bots' own CLI logins, not the reviewer.
