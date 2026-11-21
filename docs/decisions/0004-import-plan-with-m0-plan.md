# 0004. Import the plan verbatim with the M0 plan

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner

## Context

M0-16 is the issue that imports the plan into `docs/plan` and sets up the docs site. Until it lands, the issues and the M0 milestone plan have nothing in the repo to link to.

## Options

1. Commit the plan unchanged at `docs/plan/aphelion-plan.md` in the M0-00 PR, next to the M0 plan and these decision records.
2. Import the plan in its own docs PR first, then open the M0-00 PR on top.
3. Wait for M0-16, and cite plan sections by name until then.

## Decision

Option 1.

## Consequences

- Every issue links to `docs/plan/aphelion-plan.md` on `dev`. The links resolve once the M0-00 PR merges.
- M0-16's scope shrinks: it moves the plan and these records into the Starlight site instead of importing them, and it writes the records for the decisions the plan already made, numbered from 0005.
- If M0-16 moves files, it must keep these paths working or update the links in the issue bodies in the same PR (see the M0 plan's risks).
- Until M0-16 lands, the docs are plain Markdown with no build or link check.
