# 0012. The secrets broker is its own process from the start

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner
- Amended by: [decision 0016](0016-one-docker-container.md) (the broker runs inside the container as `aphelion-secrets`)
- Answers: M0 plan, Q4

## Context

The plan puts the secrets broker on the gateway host, which doesn't exist until M3-01. M0-14 builds the broker in M0.

## Options

1. A separate process from the start, under its own Unix user, reached over a local socket that only the harness can open. M3-01 moves the process to the gateway host.
2. A library inside the harness for now, made into a separate process in M3.

## Decision

Option 1. The broker runs as `aphelion-secrets`, its own system user, with its own systemd unit. It listens on a Unix socket that only `harness` can open, and its store and bootstrap credential are readable only by `aphelion-secrets`.

## Consequences

- The broker's API is a socket protocol from day one, so M3-01 moves it without changing callers.
- Agents (`aphelion-agent`) can't reach the socket or the store.
- The install script (M0-12) creates a third system user, `aphelion-secrets`. This doesn't change [decision 0010](0010-agent-folders.md): agents still share one user, however many there are.
- M0-14 also ships the broker's unit and socket permissions, with a test that `aphelion-agent` can't connect.
