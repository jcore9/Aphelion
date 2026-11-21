# 0009. Electron is the desktop shell, and the server runs beside it as a Bun process

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner
- Amended by: [decision 0017](0017-desktop-remote-only.md) (the desktop app only connects to a server; local mode is dropped)
- Amended by: [decision 0016](0016-one-docker-container.md) (desktop local mode runs everything as the desktop user, with an advisory banner)
- Confirms: the plan's choice of Electron, with a new reason now that the server runs on Bun ([decision 0007](0007-bun-runtime.md))

## Context

The plan chose Electron "because the server already runs on Node". With the server on Bun that reason no longer holds, so the shell was weighed again.

| Option | For | Against |
| --- | --- | --- |
| Electron | The same Chromium engine on every Linux distro, which suits the animation-heavy themes; mature packaging for AppImage and `.deb` | Large download (roughly 100 MB or more); its own Node runtime next to Bun |
| Tauri 2 | Small; Rust core | On Linux it renders with the system's WebKitGTK, the weakest engine for heavy animation, and it varies by distro; the server would be a bundled sidecar anyway |
| Electrobun, Wails | Small; Bun-native or Go-native | Young, with little adoption |

## Decision

Electron.

- The Electron main process stays thin: it opens the window, then either starts the local server or connects to a remote headless one over Tailscale.
- In local mode, Electron starts the server as a separate Bun process. That process is the same compiled binary that `aphelion --headless` runs, never code loaded inside Electron.
- The window loads the same web client the PWA serves.

## Consequences

- Headless and desktop run the identical server, so there's one server to test.
- The server never depends on Electron, which keeps headless mode free of GUI libraries, as M0-03 requires.
- Replacing the shell later (for example with Tauri, if WebKitGTK improves) means rewriting only the thin main process.
- The desktop app ships two runtimes: Electron's Node for the shell and the Bun-compiled server. That costs download size, which is accepted.
- M5-15 builds on this: local mode starts the bundled server binary, and remote mode connects to one.
