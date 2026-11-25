# 0003. Milestone releases use pre-release tags

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner
- Amended by: [0061](0061-release-please.md), which has release-please make each tag when the owner merges its release PR, and [0062](0062-one-main-branch.md), which drops `dev`

## Context

The Development workflow says every milestone ends with a release PR from `dev` into `main` and a tag ("`v0.1.0` and so on"), and that every commit on `main` is a tagged release. The Issue breakdown says v0.1 is the internal alpha made of M0 to M4, and v1.0 is M5 to M8. Both can't hold if each milestone bumps to its own release number.

## Options

1. Pre-release tags: milestones inside a release group tag pre-releases, and the last milestone of the group tags the release.
2. A minor version bump per milestone (M0 is v0.1.0, M1 is v0.2.0, and so on), with "v0.1 alpha" and "v1.0" kept only as names for milestone ranges.
3. Release PRs only at M4 and M8; the other milestones close on `dev`.

## Decision

Option 1.

| Milestone | Tag |
| --- | --- |
| M0 | v0.1.0-alpha.1 |
| M1 | v0.1.0-alpha.2 |
| M2 | v0.1.0-alpha.3 |
| M3 | v0.1.0-alpha.4 |
| M4 | v0.1.0 |
| M5 | v1.0.0-beta.1 |
| M6 | v1.0.0-beta.2 |
| M7 | v1.0.0-beta.3 |
| M8 | v1.0.0 |
| M9 | Decided in M9-00 |

## Consequences

- Every milestone still ends with a release PR the owner approves, and every commit on `main` is a tagged release.
- The release groups keep their meaning: v0.1.0 is the full internal alpha, and v1.0.0 is the full v1.
- Pre-release tags follow semantic versioning, so tooling sorts them correctly. The changelog gets one section per tag.
- Each milestone's GitHub description names its planned tag.
