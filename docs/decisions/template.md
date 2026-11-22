# NNNN. State the decision as one sentence

- Status: Proposed
- Date: YYYY-MM-DD
- Proposed by: who wrote the record, and in which issue or PR
- Answers: the question or design note that this record settles
- Amends: the plan text or the records that this record changes
- Amended by: records that later change this one

> How to use this template. Delete this note from your copy.
>
> - Copy this file to `NNNN-short-slug.md`, with the next free number.
> - Keep the first line as `# NNNN. Sentence`. The docs site uses it as the page title, so the record needs no frontmatter.
> - Delete the header lines that don't apply.
> - Set the status to `Proposed` while the PR is open. When the owner merges it, the status becomes `Accepted (approved by merging #N on YYYY-MM-DD)`. A record that a later one replaces becomes `Superseded by NNNN`.
> - Add a row for the record to the table in [the docs index](../README.md).
> - When the record changes the plan, edit [the plan](../plan/aphelion-plan.md) in the same PR, and follow the amendment convention at the top of the plan.

## Context

Say what forces the decision: the problem, the constraint, and what the plan or an earlier record already says. Link the issue, the spike finding or the record.

## Options

List the real options. Give each one what speaks for it and against it. A table works when the options share criteria. Where running something settles a question, run it and give the measured result, with the versions you used.

## Decision

Name the option you chose, and the rules that follow from it.

## Consequences

Say what changes: which issues, which plan text, what gets easier, and what it costs. Say when to revisit the decision.
