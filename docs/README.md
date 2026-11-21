# Aphelion docs

These are plain Markdown files until M0-16 builds them into a Starlight site.

## Plan

- [Architecture and development plan](plan/aphelion-plan.md): the plan of record, imported unchanged ([decision 0004](decisions/0004-import-plan-with-m0-plan.md)).
- Milestone plans:
  - [M0: Foundations](plan/milestones/M0-foundations.md)

## Decision records

One numbered record per significant decision: context, options, choice, consequences.

| # | Decision | Status |
| --- | --- | --- |
| [0001](decisions/0001-planning-issue-per-milestone.md) | Every milestone gets an M#-00 planning issue | Accepted |
| [0002](decisions/0002-type-docs-label.md) | Add a `type/docs` label and infer area and type labels per issue | Accepted |
| [0003](decisions/0003-release-versioning.md) | Milestone releases use pre-release tags | Accepted |
| [0004](decisions/0004-import-plan-with-m0-plan.md) | Import the plan verbatim with the M0 plan | Accepted |
| [0005](decisions/0005-bot-account-authors-prs.md) | A bot account authors agent PRs | Accepted |
| [0006](decisions/0006-shared-agent-user.md) | All agents share one Unix user; agents manage agents through tools | Accepted |
| [0007](decisions/0007-bun-runtime.md) | Bun is the server runtime and package manager; Vitest runs the tests | Accepted |
| [0008](decisions/0008-react-and-tailwind.md) | The web client uses React and Tailwind | Accepted |
| [0009](decisions/0009-electron-desktop-shell.md) | Electron is the desktop shell, and the server runs beside it as a Bun process | Accepted |
