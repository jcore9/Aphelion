# 0002. Add a type/docs label and infer area and type labels per issue

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner

## Context

The Issue breakdown defines the labels `area/server`, `area/client`, `area/gateway`, `area/plugins`, `area/security`, `area/desktop`, `type/feature`, `type/spike` and `type/chore`, and the Development workflow adds `risk/security`, `risk/breaking` and `agent-authored`. Two gaps:

- No type fits the milestone plans (M#-00) or docs-only work such as M0-16.
- The table doesn't say which labels each row gets.

## Options

1. Add `type/docs` for planning and docs-only issues, and infer the area and type labels for each row from its content.
2. Keep the label set as written, and file planning and docs issues as `type/chore`.
3. Add both `type/docs` and `type/plan`.

## Decision

Option 1. `type/docs` covers milestone plans and docs-only issues. Each issue's area and type labels were inferred from its acceptance criteria, and `risk/security` was added to issues that touch the security-sensitive paths named in the Development workflow (policy engine, secrets broker, gateway, auth, plugin permissions, install script), so their PRs get a full review from the start. The labels can be corrected on any issue without a new record.

## Consequences

- The label set is the plan's set plus `type/docs`. M0-05 documents it in CONTRIBUTING.
- Branch prefixes follow the type: `feat/`, `spike/`, `chore/`, `docs/`.
