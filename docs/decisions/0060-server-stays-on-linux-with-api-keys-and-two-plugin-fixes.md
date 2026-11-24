# 0060. The server stays on Linux in Docker and also builds for arm64, API keys join sign-ins, and two plugin isolation gaps close in M5

- Status: Proposed
- Date: 2026-11-24
- Decided by: project owner
- Proposed by: the #174 exit review PR ([#174](https://github.com/jcore9/Aphelion/issues/174))
- Answers: [#174](https://github.com/jcore9/Aphelion/issues/174), the M0 exit review of how Aphelion runs on Mac, Windows and Linux, how it uses AI tool sign-ins and API keys, and how plugins are isolated
- Amends: the plan's "Not in v1" item on macOS and Windows, its "One app, two modes" paragraph (which said v1 supports Linux only), and its M5-15 row. [0011](0011-ubuntu-lts.md), because the image also builds for arm64. [0017](0017-desktop-remote-only.md), because the desktop app builds for macOS and Windows. [0018](0018-shared-plugin-user.md), because it records two measured gaps. [0049](0049-ai-tools-installed-from-a-list.md), because the tool list keeps one checksum per architecture.
- Relies on: [0016](0016-one-docker-container.md) (one Docker container), [0019](0019-cli-subscription-use.md) (sign-ins stay with the vendor's tool), [0022](0022-bot-network-boundary.md) (option 2 is the egress proxy), [0042](0042-plugin-server-and-client-parts.md), [0057](0057-plugin-updates-from-github-releases.md), [#178](https://github.com/jcore9/Aphelion/issues/178) (one `aphelion` host command that hides Docker)

## Context

The exit review asked whether Aphelion should run directly on a Mac or Windows PC, reuse the sign-ins that Claude Code and Codex already hold there, take API keys, and keep plugins apart on every platform. This record answers each question and lists the trade-offs that remain.

Terms used below:

- A **VM** (virtual machine) is a whole computer simulated inside another one. A Linux VM on a Mac or PC can run Aphelion's container.
- **arm64** is the processor design in Apple Silicon Macs, the Raspberry Pi 5 and many cloud servers. **x86-64** is the design in most PCs and older Macs. A program built for one does not run on the other, so an image is built twice.
- **WSL2** (Windows Subsystem for Linux 2) is Microsoft's built-in way to run a Linux VM on Windows.
- An **environment setting** is a named value that a program reads when it starts. Aphelion can set one for a tool without writing the value to a file.
- An **egress proxy** is a gate that all outgoing internet traffic of a program must pass. It allows approved hosts and refuses the rest. [0022](0022-bot-network-boundary.md) calls this option 2.
- A **sign-in** is the login a vendor's tool keeps in a file after the owner signs in with a subscription. An **API key** is a secret string that pays per use instead.

Each fact below is labeled **measured** (run on 2026-11-24 with harmless canary files; the results are quoted below), **docs** (read on that date, with a link) or **inferred** (reasoned from the others).

## Options

### 1. Where the server runs

| Option | For | Against |
| --- | --- | --- |
| Linux in Docker only. Mac, Windows and phones are clients. | Everything stays as [0011](0011-ubuntu-lts.md), [0016](0016-one-docker-container.md) and [0017](0017-desktop-remote-only.md) say. One tested setup. | A Mac or Windows owner needs a Linux VM or machine. |
| Host mode: the server runs on the owner's computer and uses its sign-ins. | No Docker, and existing sign-ins work. | Bots would run as the owner, so they could read the owner's files, the secrets store and the approval rules. Approvals would only be advice. |

Host mode fails on the Codex check. Codex CLI 0.172.0 on Linux, `workspace-write` sandbox, canary file outside the work folder:

| Check | Result |
| --- | --- |
| Read the canary outside the work folder | Allowed (measured) |
| Write to one folder under the home directory | Refused (measured). Writes under `/tmp` are allowed by default in this mode. |
| Codex's own sign-in file `~/.codex/auth.json` | Readable (measured with `test -r`, never read) |
| List `~/.ssh` | Allowed (measured) |
| Network | A DNS lookup failed (measured). No other network check was run. |

Host mode is rejected because the sandbox let a command read the canary outside the work folder, and the sign-in file is readable. Once Claude Code's sandbox is enabled, its [sandboxing docs](https://code.claude.com/docs/en/sandboxing) say the default is "read access to the entire computer, except certain denied directories" and that the default "still allows reading credential files" (docs). That default applies to shell commands. Claude's sandbox was not run, because it needs a signed-in session.

Mac and Windows facts for the later VM installer:

- Apple's [Virtualization framework](https://developer.apple.com/documentation/virtualization) creates VMs that run Linux on Apple Silicon and Intel Macs (docs).
- [WSL2 is available on Windows 10 Home and Windows 11 Home](https://learn.microsoft.com/en-us/windows/wsl/faq) (docs). The one-command install needs Windows 10 version 2004 or later, or Windows 11 ([install page](https://learn.microsoft.com/en-us/windows/wsl/install), docs). A manual install supports some earlier x64 builds ([manual install](https://learn.microsoft.com/en-us/windows/wsl/install-manual), docs).
- A VM or WSL2 on a computer that sleeps pauses the server while the computer sleeps (inferred).

### 2. arm64

| Option | For | Against |
| --- | --- | --- |
| x86-64 only | One build. | No Apple Silicon VM, Raspberry Pi 5 or ARM cloud server. |
| x86-64 and arm64 from M1 | This lets those machines run the image once the arm64 build is verified. | Automated builds run twice, and each AI tool needs a checksum per architecture. |

Both base images publish arm64 (docs): `oven/bun:1.4.5` lists amd64 and arm64 on [Docker Hub](https://hub.docker.com/r/oven/bun/tags), and `ubuntu:26.04` lists amd64, arm64 and four more ([Docker Hub](https://hub.docker.com/_/ubuntu/tags)). No arm64 image build was run. Whether every pinned AI tool ships an arm64 download is **not confirmed**, and the arm64 issue must check it.

### 3. Existing sign-ins

| Option | For | Against |
| --- | --- | --- |
| Never reuse or mount the host's sign-ins. The owner signs in once inside Aphelion. | [0019](0019-cli-subscription-use.md) holds as written. The vendor's own flow runs, and Aphelion never sees the token. | One extra sign-in per tool. |
| Mount the host's sign-in folders into the container. | No extra sign-in. | Bots would read files the owner's own tools also use, and a bot could damage them. Aphelion would touch credentials it must leave alone. |

### 4. API keys

| Option | For | Against |
| --- | --- | --- |
| Stored in the secrets broker, handed to the tool as an environment setting at bot start. | Uses the existing encrypted store. Plugins never see it. | A tricked bot can read its own key. |
| A proxy adds the key on the way out, so bots never hold it. | The key never reaches a bot process. | Needs the egress proxy from [0022](0022-bot-network-boundary.md) option 2, which does not exist yet. |

The first option ships first. The sign-in token file has the same exposure today. The proxy can come later.

### 5. Providers with an API and no CLI

| Option | Picked by | For | Against |
| --- | --- | --- | --- |
| Drive an open-source CLI such as OpenCode. | orchestrator recommended | Less to build. [0049](0049-ai-tools-installed-from-a-list.md) already lists OpenCode. | The key must reach that process, and approvals depend on that CLI's own permission hooks. |
| Aphelion's own bot engine: Aphelion calls the provider and runs the file and command tools itself, through the approval layer ([#28](https://github.com/jcore9/Aphelion/issues/28)). | owner | Aphelion holds the key and no bot process does. Every tool call goes through the approval layer directly. | Aphelion maintains the engine, and the design spike must show the effort. |

The orchestrator recommended the OpenCode route because it costs less. The owner chose Aphelion's own engine because it gives more control.

### 6. Plugin isolation, measured in the image

Run in the built image with the Compose hardening that matters (read-only filesystem, no extra capabilities, `no-new-privileges`), as user `aphelion-plugins`. The firewall rules of [0022](0022-bot-network-boundary.md) were not installed on the test box. The test used Docker's default network. The same holds on a real host, since [0022](0022-bot-network-boundary.md) allows the public internet (inferred).

| Check | Result |
| --- | --- |
| Plugin B reads plugin A's data folder | **Readable** (measured). Both run as one user, so the folder mode `0700` does not separate them. Gap (a). |
| Plugin opens its own connection to the internet | **Connects** (measured): HTTPS to example.com and TCP to 1.1.1.1:443 both succeeded. The host checks `permissions.network` only for calls made through it. Gap (b). |
| List bot folders, where sign-ins live | Refused (measured) |
| Host files | No host folder is mounted into the container besides the plugin data volume and Docker's own name files (measured) |
| Config, state, secrets, broker socket, bootstrap secret, server file descriptors | Refused. Prior coverage from the existing `deploy/test/image-contract.sh`, not re-run here. |

### 7. Plugin commands

Plugins install, update, roll back and list through the server, which is always Linux, so the steps are identical on every computer the owner uses. They join the host command from [#178](https://github.com/jcore9/Aphelion/issues/178) with no Docker words.

## Decision

All answers are as the owner decided on 2026-11-24.

**Supported platforms**

| Part | Where it runs |
| --- | --- |
| Server | Ubuntu LTS 26.04 in Docker. x86-64 now, arm64 from M1. On a spare machine, a Linux VM made by hand (including on a Mac or PC), or a cloud server. |
| Web app | Any current browser. |
| Desktop app | Linux, macOS (Apple Silicon and Intel) and Windows 10 and 11, Home included. It only connects to a server. |
| Phone app | Later, as the plan says. |

**Recommended default.** One Linux machine or VM runs the container. The owner signs in once per AI tool inside it. The apps connect over Tailscale.

**Rules**

1. The server runs on Linux in Docker. There is no host mode. Mac, Windows and phones are clients.
2. An installer that creates a small Linux VM on a Mac (Apple's Virtualization framework) or Windows PC (WSL2) and runs the same container gets a design spike in M9 Later, next to the VM per bot spike ([#160](https://github.com/jcore9/Aphelion/issues/160)): [#185](https://github.com/jcore9/Aphelion/issues/185).
3. The image builds for x86-64 and arm64 from M1: [#180](https://github.com/jcore9/Aphelion/issues/180). [#155](https://github.com/jcore9/Aphelion/issues/155) pins each AI tool's checksum per architecture.
4. Aphelion never reuses or mounts a sign-in from the host. The owner runs `sudo aphelion sign-in <tool>` ([#178](https://github.com/jcore9/Aphelion/issues/178)), and the vendor's own flow does the rest. [0019](0019-cli-subscription-use.md) is unchanged.
5. An API key is an alternative to a sign-in: [#181](https://github.com/jcore9/Aphelion/issues/181).
   - The secrets broker stores it encrypted.
   - The owner can add, test, replace and remove it. A test is a lightweight check the provider supports, such as listing models.
   - After entry the key is never shown again. It stays out of logs, prompts and plugin processes.
   - Aphelion hands the key to the tool as an environment setting when the bot starts.
   - [#181](https://github.com/jcore9/Aphelion/issues/181) covers the broker storage, the `aphelion key` commands and the Claude adapter ([#20](https://github.com/jcore9/Aphelion/issues/20)). Key use for Grok ([#44](https://github.com/jcore9/Aphelion/issues/44)) and Codex ([#114](https://github.com/jcore9/Aphelion/issues/114)), and which one wins when a key and a sign-in both exist, belong to those adapter issues.
   - `aphelion key add`, `test`, `replace` and `remove` land in M1 through [#178](https://github.com/jcore9/Aphelion/issues/178). The app screen comes in M5.
   - A proxy that adds the key on the way out can come later with [0022](0022-bot-network-boundary.md) option 2.
6. A provider with an API and no CLI runs on Aphelion's own bot engine. A design spike in M9 Later covers it: [#184](https://github.com/jcore9/Aphelion/issues/184).
7. Both plugin gaps are fixed in M5, and both block plugin install by other people ([#65](https://github.com/jcore9/Aphelion/issues/65)):
   - [#182](https://github.com/jcore9/Aphelion/issues/182) gives each plugin its own data area that no other plugin can read.
   - [#183](https://github.com/jcore9/Aphelion/issues/183) stops a plugin from opening its own internet connections. A direct connection must fail even to a host the plugin was granted, while the same request through the host's `network.get` works. If plugins go through a proxy instead, the proxy must enforce each plugin's own grants. It ties to [0022](0022-bot-network-boundary.md) option 2.
   - The owner's own plugins are fine until then.
8. `aphelion plugin install`, `update`, `rollback` and `list` join [#178](https://github.com/jcore9/Aphelion/issues/178), and work the same on every computer.
9. The desktop app ([#67](https://github.com/jcore9/Aphelion/issues/67)) gets build targets for macOS and Windows as well as Linux. Signed releases belong to [#68](https://github.com/jcore9/Aphelion/issues/68) (M5-16). Apple's [developer program](https://developer.apple.com/programs/) costs US$99 a year (docs). A Windows signing certificate also costs money (inferred, price not checked). Windows SmartScreen may warn on downloaded builds until they build reputation, signed builds included ([Microsoft](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation), docs).

**Remaining trade-offs for the owner to confirm at the M0 exit review**

- A Mac or Windows owner needs a Linux VM or machine until the M9 installer spike is done and built.
- A tricked bot can read its own API key or sign-in token file. The proxy later removes this for API keys only.
- The plugin gaps stay open until M5. Until then only the owner's own plugins should be installed.
- Signing the desktop app costs about US$99 a year for Apple, plus a Windows certificate. Windows may still warn on new downloads.
- Providers with only an API wait for the M9 engine.

## Consequences

- Six new issues ([#180](https://github.com/jcore9/Aphelion/issues/180) to [#185](https://github.com/jcore9/Aphelion/issues/185)), and comments on [#178](https://github.com/jcore9/Aphelion/issues/178), [#155](https://github.com/jcore9/Aphelion/issues/155), [#67](https://github.com/jcore9/Aphelion/issues/67), [#68](https://github.com/jcore9/Aphelion/issues/68), [#44](https://github.com/jcore9/Aphelion/issues/44) and [#114](https://github.com/jcore9/Aphelion/issues/114).
- The plan's "Not in v1" item, its "One app, two modes" paragraph and its M5-15 row change in this PR. [0011](0011-ubuntu-lts.md), [0017](0017-desktop-remote-only.md), [0018](0018-shared-plugin-user.md) and [0049](0049-ai-tools-installed-from-a-list.md) gain an "Amended by" line.
- No code and no test changed. The feasibility check ran on an image built from `dev` at `ab1089f` and on Codex CLI 0.172.0. Its scripts were throwaway and are not in the repo.
- Revisit this record when:
  - the arm64 build finds an AI tool without an arm64 download,
  - the M9 spikes report, or
  - a vendor changes its sandbox so reads are confined by default.
