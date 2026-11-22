# 0032. The native app stack is chosen in M9

- Status: Accepted
- Date: 2026-11-21
- Decided by: plan of record (imported in [0004](0004-import-plan-with-m0-plan.md))
- Answers: the plan's Open decisions, "Native app stack"

## Context

The native app comes after v1.0, in stage 9. It reuses the client protocol over Tailscale and adds push notifications through APNs and FCM.

## Options

Tauri mobile, React Native, or Swift and Kotlin.

## Decision

No stack is chosen now. M9-01 picks one in an opening spike.

## Consequences

- Until M9, the protocol stays usable from any client, as the plan requires ("Serve a web client first, with a protocol a native app can reuse later").
- [Decision 0008](0008-react-and-tailwind.md) counts a React Native path for M9 as one reason for React. It doesn't choose the native stack.
