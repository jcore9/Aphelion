# 0005. A bot account authors agent PRs

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner
- Answers: M0 plan, Q1

## Context

GitHub doesn't let a pull request's author approve it. The first PRs were opened from the owner's own account, so once branch protection requires an approving review on `dev`, the owner couldn't approve anything the coding tools open.

## Options

1. A dedicated bot identity (a machine user or a GitHub App) authors agent PRs, and the owner approves them from their own account.
2. Branch protection requires a PR and green CI but no approving review, and the owner's merge stands in for the approval.

## Decision

Option 1, using a machine user account, `jcore9-bot`.

- The bot is a repo collaborator with the **Write** role only: enough to push branches and open PRs, but not to change settings, protection rules or secrets.
- Commits from coding tools use the bot's GitHub noreply address.
- Branch protection on `dev` and `main` (M0-05) requires an approving review and blocks direct pushes, so the bot can push only to its own branches.
- PRs the bot opens carry the `agent-authored` label.

## Consequences

- The owner approves PRs from their own account, which is the review the Development workflow asks for.
- Until M0-05 turns on branch protection, the Write role lets the bot push to `dev` and `main` directly. The coding tools follow the workflow and don't, but nothing stops them until M0-05 (b) lands, so that sub-issue goes first once M0-04 lands.
- The bot's GitHub sign-in on the dev machine is a long-lived credential. It's separate from the GitHub App that the M3 connector uses, which mints short-lived tokens per call.
- PR #90 (the M0 plan) was opened from the owner's account before this decision. It gets reopened from the bot so it can be approved.
