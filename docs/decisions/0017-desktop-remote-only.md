# 0017. The desktop app only connects to a server; it never runs one

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner
- Amends: the plan's "One app, two modes" and Must do (v1), [0009](0009-electron-desktop-shell.md) (local mode), [0016](0016-one-docker-container.md) (desktop local mode), M5-15

## Context

[Decision 0016](0016-one-docker-container.md) kept a desktop local mode that ran the server directly as the desktop user, with a banner saying approvals were advisory. That breaks the plan's first principle, that agents are untrusted and enforcement lives outside their reach. Every protection Aphelion has depends on the server running in its container.

## Options

1. Keep local mode as advisory, with the banner.
2. Create the same users through the `.deb` installer, so local mode gets real isolation.
3. Drop local mode. The desktop app is a client that only connects to a server.

## Decision

Option 3. **Aphelion runs only as the server container, with its protections. Every client connects to it.**

- The desktop app is Electron wrapping the web client. It doesn't bundle or start the server binary.
- To use Aphelion on a single machine, run the container on that machine and connect the desktop app to it. The server is still reached only on a tailnet address, even from the same machine, so there's one network path to secure and test.
- The plan's "one app, two modes" becomes two deliverables: the server image, and clients (the PWA and the desktop app) that connect to it.

## Consequences

- One security model everywhere. There's no advisory mode, and no banner explaining one.
- Trying Aphelion needs Docker and Tailscale, even on one machine. That's the accepted cost.
- The desktop app gets smaller and simpler: no Bun runtime and no server process to manage. Electron stays the shell for the reasons in 0009.
- The M0-03 spike drops its question about Electron starting the server.
- M5-15 becomes a connect-only desktop app: pair with a server, store its device token, reconnect. AppImage and `.deb` builds are unchanged.
- When M0-16 moves the plan into the docs site, it rewrites the plan's "One app, two modes" paragraph and its first Must do item.
