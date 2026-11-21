# 0015. The 1Password backend is tested against a mock in CI

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner
- Answers: M0 plan, Q7

## Context

M0-15 resolves `op://` references through 1Password's official SDK. A live test in CI would need a service-account token stored as a GitHub Actions secret, which puts a credential outside the gateway.

## Options

1. A mocked SDK in CI, plus a live test run by hand with its output in the PR.
2. A live test in CI with a token in GitHub Actions secrets.

## Decision

Option 1.

## Consequences

- No 1Password credential is stored on GitHub.
- The M0-15 PR includes the output of a manual run against a real vault limited to test items.
- An SDK change that the mock doesn't reflect is caught only at the next manual run, so the SDK version is pinned, and every bump to it reruns the live test.
