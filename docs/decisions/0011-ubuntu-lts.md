# 0011. v1 supports the current Ubuntu LTS

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner
- Answers: M0 plan, Q3
- Amended by: [0060](0060-server-stays-on-linux-with-api-keys-and-two-plugin-fixes.md) (the image also builds for arm64)

## Context

The install script, the spikes and the exit test need a target distro. The M0 plan recommended current Debian stable plus the current Ubuntu LTS, on systemd 250 or later.

## Options

1. Current Debian stable and the current Ubuntu LTS.
2. The current Ubuntu LTS only.

## Decision

Option 2: the current Ubuntu LTS (26.04 at the time of writing), server and desktop editions. Its systemd is well past 250, so `systemd-creds` with TPM binding, polkit and template units are all available.

## Consequences

- M0-03, M0-12 and the exit test run on Ubuntu only, which halves the test matrix.
- Debian, the previous Ubuntu LTS and other distros may work but aren't tested or supported in v1. Adding one later is a new decision record plus a CI and exit-test run.
- The `.deb` packaging from M0-03 targets Ubuntu's package versions.
