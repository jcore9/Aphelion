# 0001. Every milestone gets an M#-00 planning issue

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner

## Context

The plan says every milestone opens with a planning issue (M#-00) that is reviewed before the milestone's other issues start. The Issue breakdown only has an M#-00 row for M0, so the rule and the table disagree for M1 to M9.

## Options

1. Create M1-00 to M9-00 now, and make each one a dependency of the other issues in its milestone, the same way M0-00 is.
2. Create only the rows in the table, and file each later milestone's plan when that milestone starts.

## Decision

Option 1. Each milestone has a "[M#] Milestone plan" issue, and every other issue in that milestone lists it under "Depends on". Those issue bodies say that the row was added under this record.

## Consequences

- The issue tracker shows a planning gate in front of every milestone, so no milestone's work can look ready before its plan is approved.
- The Issue breakdown in [the plan](../plan/aphelion-plan.md) still lists only M0-00. When M0-16 moves the plan into the docs site, the table should gain the M1-00 to M9-00 rows so the plan and the tracker match.
