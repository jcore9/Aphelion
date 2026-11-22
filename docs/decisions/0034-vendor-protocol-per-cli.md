# 0034. Each agent CLI is driven over its vendor's own protocol

- Status: Accepted
- Date: 2026-11-22
- Decided by: project owner
- Amends: [0027](0027-acp-first-adapters.md) (ACP first, for Claude Code and Codex), [0019](0019-cli-subscription-use.md) ("the official ACP adapter"), [0024](0024-codex-third-agent-cli.md) (the Codex transport), [0028](0028-policy-engine-in-harness.md) (the policy engine's inputs), and the plan's Agent adapters, Policy engine, Enforcement layers, Stages, Open decisions and Issue breakdown

## Context

[Decision 0027](0027-acp-first-adapters.md) made the [Agent Client Protocol](https://agentclientprotocol.com/) (ACP) the first choice for every CLI, with each CLI's own streaming output as a fallback. Two spikes then tested ACP against what Aphelion needs:

- **Claude.** The [M0-01 finding](../spikes/M0-01-claude-over-acp.md) found that `@agentclientprotocol/claude-agent-acp` works. That adapter is built on Anthropic's [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview.md), so ACP adds a second translation on top of the SDK and a third-party package between Aphelion and the CLI.
- **Codex.** The [M0-17 finding](../spikes/M0-17-codex-headless.md) found that `codex-acp` fails every prompt under a root-owned `requirements.toml` that allows only `untrusted`. `codex app-server` JSON-RPC (a way to send requests and replies as JSON messages) works under it, and under `untrusted` it asks before each shell command and file change. It doesn't make every call ask: [decision 0035](0035-codex-login-sandbox-approvals.md) lists the limits that M0-17 measured, and the managed hook covers some of them.

Grok Build speaks ACP itself, as `grok agent stdio` ([M0-02](https://github.com/jcore9/Aphelion/issues/3)).

T3 Code, a self-hosted program that drives the same three CLIs, uses each vendor's own protocol. The orchestrator read the live process list and the code bundled in T3 Code 0.1.12-nightly.20261121 on this box on 2026-11-22:

| CLI | How T3 Code drives it |
| --- | --- |
| Claude Code | It bundles `@anthropic-ai/claude-agent-sdk` 0.3.321, which starts `claude --output-format stream-json --input-format stream-json --permission-prompt-tool=stdio --resume <id>`. |
| Codex | `codex app-server -c thread_unload_delay_secs=0`, through its own `effect-codex-app-server` package. There's no `codex-acp`. |
| Grok Build | `grok agent stdio`, which is ACP. It adds `--always-approve` only in full-access mode. |

### The Agent SDK on Bun, measured

On 2026-11-22, one turn ran on this box with `@anthropic-ai/claude-agent-sdk` 0.3.330, Bun 1.4.5 and the system Claude Code 2.1.330 at `/usr/bin/claude`. It used the box's cached claude.ai login, with `ANTHROPIC_API_KEY` and every `CLAUDE*` variable removed from the child's environment. The run was not saved as a script in the repo. M1-02 turns it into a test.

The options were `pathToClaudeCodeExecutable: "/usr/bin/claude"`, `permissionMode: "default"`, `settingSources: []`, `tools: ["Read", "Write"]`, a `canUseTool` callback that allowed each call, and a `PreToolUse` hook callback. The prompt asked Claude to read a one-line file outside its working directory, then write a copy into it.

- **It runs on Bun.** The SDK started the given binary. The `init` message reported `claude_code_version: "2.1.330"`, `apiKeySource: "none"` and `permissionMode: "default"`. The turn ended with `subtype: "success"` and `permission_denials: []`, and the file was written.
- **It runs the binary it's given.** A stand-in script at `pathToClaudeCodeExecutable` recorded its arguments: `--output-format stream-json --verbose --input-format stream-json --permission-prompt-tool=stdio --setting-sources= --permission-mode=default`. That's the same stream-json protocol that T3 Code runs, and the same protocol that M1-03 would have built by hand.
- **Permission requests reach Aphelion's code.** `canUseTool` ran twice: for `Read`, with `decisionReason: "Path is outside allowed working directories"`, and for `Write`. Each call carried a `toolUseID`. The suggestions offered a session-wide `addRules` grant and a switch to `acceptEdits`, and the harness must never return either.
- **The hook callback saw both calls** before `canUseTool` did.
- **Subscription usage arrives in the stream.** `rate_limit_event` messages reported how much of the five-hour and seven-day subscription allowance was used (`five_hour` and `seven_day` utilization). The seven-day window went from 0.74 to 0.75 during the turn, so the turn drew on the subscription.

Still unknown, for M1-02:

- **Does a read inside the working directory ask?** Not known for the bare SDK. M0-01 measured the ACP wrapper, where such a read ran with no request in `default` mode. This turn read a file outside the working directory only. M1-02 checks it. Whether the SDK's own `PreToolUse` callback can share the managed hook's job (M2-05) is M2-05's question.
- **The bundled binary.** The SDK's optional dependency `@anthropic-ai/claude-agent-sdk-linux-x64` holds a 364 MB copy of Claude Code. The image must leave it out and set `pathToClaudeCodeExecutable` every time, or the SDK runs that copy instead of the pinned one.
- **Version pairing.** SDK 0.3.330 pairs with Claude Code 2.1.330. The SDK's docs say some options, such as `mcpServersDelivery: "initialize"`, need the bundled CLI version or newer. M1-02 pins the two together.
- **Managed settings.** `/etc/claude-code/` doesn't exist on this box, so this turn didn't test whether `settingSources: []` still loads root-owned managed settings.
- **Inside the container.** Running as `aphelion-agent` under the hardening from [decision 0016](0016-one-docker-container.md), deny answers, `resume` after a restart, and Bun's peer dependencies (`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk` and Zod 4) in a plugin folder.
- **The default mode.** Not known for the bare SDK. M0-01 found that the ACP wrapper started in `auto` where that mode is available, and the direct run here set `default` explicitly. The adapter always passes `default`, and the managed settings disable `auto` and `bypassPermissions`. M1-02 checks what the SDK does with no `permissionMode`.

## Options

| Option | For | Against |
| --- | --- | --- |
| 1. ACP for every CLI ([0027](0027-acp-first-adapters.md)) | One protocol and one parser. | Claude goes through a third-party adapter that wraps the Agent SDK. `codex-acp` can't meet M2-04 (M0-17). Each fix waits on the adapter's maintainers. |
| 2. Each vendor's own protocol | Each CLI is driven the way its vendor supports. No translation layer and no third-party package between Aphelion and the CLI. Permission requests arrive with the vendor's own fields. Usage windows arrive in the stream (`rate_limit_event`, `account/rateLimits/updated`). | Three protocols and three parsers behind the adapter contract. |
| 3. A mix: ACP where it works, the vendor's protocol where it doesn't | Keeps ACP for Claude, where `claude-agent-acp` works. | Claude still goes through a wrapper around the SDK it could call directly. It is option 2 for Codex anyway. |

The adapter contract from M1-01 already normalizes each CLI's output into one event type, so the cost of option 2 stays inside each adapter plugin.

## Decision

Option 2. The owner decided on 2026-11-22.

| CLI | Protocol | Adapter |
| --- | --- | --- |
| Claude Code | The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), which speaks stream-json to the CLI | [M1-02](https://github.com/jcore9/Aphelion/issues/20) |
| Codex | `codex app-server`: JSON-RPC (requests and replies as JSON messages) over stdio (the process's standard input and output) | [M4-10](https://github.com/jcore9/Aphelion/issues/114) |
| Grok Build | ACP, as `grok agent stdio` | [M4-01](https://github.com/jcore9/Aphelion/issues/44) |

Rules that follow:

- **The pinned binary.** Each adapter starts the pinned, unmodified CLI in the image. The Claude adapter sets `pathToClaudeCodeExecutable` on every call and never installs the SDK's bundled binary.
- **No bypass modes.** The Claude adapter always passes `permissionMode: "default"` and answers every `canUseTool` call from the policy engine. It never returns a suggested rule or mode change, which would make a grant last for the session. The Codex adapter follows [decision 0035](0035-codex-login-sandbox-approvals.md). The Grok adapter never passes `--always-approve`.
- **No fallback adapter.** The Agent SDK is the stream-json protocol, so there's no separate stream-json fallback for Claude. M1-03 is closed.
- **One contract.** All three adapters emit the M1-01 events. A CLI that can't fit them gets a contract change proposed in its own issue.

## Consequences

- **[0027](0027-acp-first-adapters.md)** stays for Grok and is amended for Claude and Codex.
- **[0019](0019-cli-subscription-use.md)**'s first guardrail now reads as "the official, unmodified CLIs, driven through each vendor's own SDK or protocol, at pinned versions". The Agent SDK is Anthropic's own package and runs the unmodified `claude` binary, so the guardrail holds. The Agent SDK overview says third-party developers may not "offer claude.ai login or rate limits for their products" without approval (quoted in M0-01). Aphelion offers neither, because the owner signs in to their own CLI.
- **[0024](0024-codex-third-agent-cli.md)** said "the official ACP adapter if the spike picks one". The spike didn't pick one, and M4-10 speaks app-server directly.
- **[0028](0028-policy-engine-in-harness.md)**'s inputs are each adapter's permission requests and the hook callbacks, not only ACP requests.
- **The plan's Sources** keep the ACP links for Grok. The Agent SDK and app-server docs join them when M1-02 and M4-10 land.

The issues change:

| Issue | Change |
| --- | --- |
| [M1-02](https://github.com/jcore9/Aphelion/issues/20) | Renamed "Claude adapter plugin (Agent SDK)". Uses the Agent SDK with the pinned binary, `default` mode and `canUseTool`, and answers the open points above. |
| [M1-03](https://github.com/jcore9/Aphelion/issues/21) | Closed as not planned. The Agent SDK is the stream-json protocol. |
| [M2-04](https://github.com/jcore9/Aphelion/issues/30) | Renamed "Adapter permission routing". Claude's `canUseTool`, Codex's three request types and Grok's ACP requests all go to the policy engine. |
| [M4-10](https://github.com/jcore9/Aphelion/issues/114) | Speaks `codex app-server` directly. |
| [M4-01](https://github.com/jcore9/Aphelion/issues/44) | No change. Grok stays on `grok agent stdio`. |
| [M1-07](https://github.com/jcore9/Aphelion/issues/25) | No change. The recorded streams are now SDK messages, app-server JSON-RPC and ACP. |

Revisit this record if a vendor retires its protocol, or if a vendor's ACP support becomes the way that vendor supports headless use.
