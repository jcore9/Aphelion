# 0013. Tailscale identity ships in M0 only if it needs no operator rights

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner
- Answers: M0 plan, Q5

## Context

The plan wants device identity from Tailscale plus a per-device token. Asking Tailscale who a peer is (its `whois` lookup) may need access to the local Tailscale socket, which the `harness` user may not have by default. Granting operator rights would give the harness more control over Tailscale than it needs.

## Options

1. M0-10 (b) checks whether `harness` can do the lookup without operator rights. If it can, it ships in M0; if not, M0 ships token-only plus binding to the tailnet address, and the identity check gets its own issue in M5.
2. Grant operator rights and ship it in M0 regardless.
3. Token-only for v1.

## Decision

Option 1. The harness is never made a Tailscale operator.

## Consequences

- M0's minimum is unchanged: a tailnet-only bind plus a per-device token.
- If the lookup needs more than plain socket access, the M0-10 (b) PR records the finding and files the M5 issue.
