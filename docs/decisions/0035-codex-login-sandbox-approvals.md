# 0035. Codex runs on the owner's ChatGPT login, with its own sandbox in the container and `untrusted` approvals on a pinned version

- Status: Accepted
- Date: 2026-11-22
- Decided by: project owner
- Answers: the three owner questions in the [M0-17 finding](../spikes/M0-17-codex-headless.md#questions-for-the-owner)
- Amends: [0016](0016-one-docker-container.md) (the container's seccomp profile), [0024](0024-codex-third-agent-cli.md) (what it left undecided), [0022](0022-agent-network-boundary.md) (the option 2 egress allowlist)

## Context

The [M0-17 finding](../spikes/M0-17-codex-headless.md) showed that `codex app-server` runs a turn with tool calls on the owner's ChatGPT Plus login, and that the `untrusted` approval policy makes every shell command and file change ask. It stopped on three questions:

1. **Terms.** OpenAI's terms don't address one person driving their own Codex from a self-hosted program. The [auth docs](https://learn.chatgpt.com/docs/auth) say "API keys are still the recommended default for automation."
2. **Sandbox.** Codex's Linux sandbox uses `bwrap`, which needs a user namespace. Docker's default seccomp profile blocks that, so in the hardened container from [decision 0016](0016-one-docker-container.md) every sandboxed command fails. With `--security-opt seccomp=unconfined`, the sandbox started and blocked a write outside the workspace.
3. **`untrusted` is being retired.** The [approvals docs](https://learn.chatgpt.com/docs/agent-approvals-security) say Codex "no longer support[s]" it. Codex 0.169.0 refuses it in `config.toml`, but still honors it from `thread/start` and from a root-owned `requirements.toml`.

[Decision 0034](0034-vendor-protocol-per-cli.md) settles the protocol: the Codex adapter speaks `codex app-server` JSON-RPC.

## Options

For the login:

1. The owner's ChatGPT login, under [decision 0019](0019-cli-subscription-use.md)'s guardrails.
2. An OpenAI API key, billed per token.
3. Leave Codex out.

For the sandbox:

1. A seccomp profile that allows user namespaces, so Codex's own sandbox runs inside the container.
2. `danger-full-access` in `requirements.toml`, so commands run unsandboxed, gated only by `untrusted` approvals and the managed hook. The container is then the only boundary around each command.

For "every call asks":

1. A pinned Codex version that still honors `untrusted`, plus the fail-closed managed hook.
2. Wait until OpenAI ships a supported way to ask before every call.

## Decision

The owner chose option 1 for all three on 2026-11-22.

**The login.** Codex runs on the owner's own ChatGPT login, under the guardrails in 0019:

- Aphelion runs the official, unmodified `codex` binary at a pinned version.
- The owner signs in with `codex login --device-auth`, run as `aphelion-agent` inside the container, with `cli_auth_credentials_store = "file"`. Aphelion never asks for, reads, copies, logs or transmits `auth.json`.
- One person's own subscription, never routed for other people.
- An API key per agent stays possible through the secrets broker.

**The sandbox.** The container gets a custom seccomp profile that allows user namespaces, so Codex's own sandbox runs inside it. `requirements.toml` allows only `read-only` and `workspace-write`, so `danger-full-access` stays unreachable.

**Every call asks.** The adapter rests on a pinned Codex version that still honors `untrusted`, plus the managed `PreToolUse` hook that fails closed by itself. This is revisited when OpenAI ships a supported replacement for `untrusted`.

The settings, from the M0-17 finding:

- **Each thread** starts with `approvalPolicy: "untrusted"` and `approvalsReviewer: "user"`.
- **Approvals** are answered with `accept`, `decline` or `cancel` only. Never `acceptForSession` or `acceptWithExecpolicyAmendment`, which save lasting grants.
- **`/etc/codex/requirements.toml`**, root-owned:
  - `allowed_approval_policies = ["untrusted"]`
  - `allowed_sandbox_modes = ["read-only", "workspace-write"]`
  - `allowed_approvals_reviewers = ["user"]`
  - `allow_managed_hooks_only = true` and `[features] hooks = true`
  - `check_for_update_on_startup = false`
  - `allowed_web_search_modes = []`
- **The managed hook** in `/etc/codex/hooks.json` matches every tool. It catches every error, keeps its own deadline shorter than Codex's `timeout`, and exits 2 on any failure. Codex runs the tool when a hook crashes or times out, so only a hook that fails closed by itself is safe.
- **`$CODEX_HOME/rules`** stays out of the agent's reach, because a user `allow` rule silences `untrusted`.

## Consequences

**The seccomp profile applies to the whole container, not only to Codex.** Today the server, the secrets broker, the plugin runner and every agent share one container ([0016](0016-one-docker-container.md)). With this profile, any of them can create a user namespace. Inside it, a process is root over that namespace, and it reaches kernel code that Docker's default profile keeps out of reach, such as mounting filesystems and setting up netfilter rules in a new network namespace. A kernel bug in that code becomes reachable from a prompt-injected agent, and a kernel bug can escape the container. That's more kernel attack surface for the whole container, including for agents that never run Codex.

The mitigations:

- **The smallest profile.** Start from Docker's default profile and add only the system calls that `bwrap` needs. Never `seccomp=unconfined`.
- **The rest of the hardening stays.** `cap_drop: ALL`, `no-new-privileges` and the read-only root stay as they are. Capabilities inside a user namespace give no rights outside it.
- **No full access.** `requirements.toml` keeps `danger-full-access` out, so every Codex command runs inside its sandbox.
- **A patched host kernel.** The install guide requires the host's kernel security updates. On Ubuntu, AppArmor's `kernel.apparmor_restrict_unprivileged_userns` may need a profile for the container, and the guide says exactly which change.
- **Later, a smaller scope.** If agents move to their own container ([0022](0022-agent-network-boundary.md) option 2), the profile applies to that container only, not to the server or the broker.

The [M0-18 spike](https://github.com/jcore9/Aphelion/issues/124) measures these: the exact difference from Docker's default profile, what it exposes, the AppArmor change on Ubuntu 26.04, and whether Codex's sandbox starts with it. M0-18 also asks whether the same namespaces can isolate each agent, which would put the profile to a second use.

**`untrusted` on a pinned version has a cost.**

- A Codex upgrade is a deliberate step. Before each bump, the M0-17 checks rerun against the new version: `untrusted` from `thread/start` and from `requirements.toml`, the hook, and the coerced fallbacks. A version that drops `untrusted` isn't adopted.
- A pinned version can miss Codex security fixes, and OpenAI's servers may stop accepting an old client. Either one stops Codex until OpenAI ships a replacement, or until the owner revisits this record.
- The managed hook is the gate that doesn't depend on `untrusted`. It ships with M4-10, not later.

**Terms.** OpenAI's auth docs recommend API keys for automation. The owner accepts that, as for Claude and Grok in 0019. If OpenAI publishes wording that rules this case out, Codex switches to an API key.

**Egress.** [0022](0022-agent-network-boundary.md)'s option 2 allowlist adds `api.openai.com`, `chatgpt.com` and `auth.openai.com`. Login, token refresh and the ChatGPT WebSocket through the proxy are still untested.

**The issues change:**

| Issue | Change |
| --- | --- |
| [M4-10](https://github.com/jcore9/Aphelion/issues/114) | No longer waits on the owner. Uses the settings above. |
| [M2-04](https://github.com/jcore9/Aphelion/issues/30) | Codex sends `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` and `mcpServer/elicitation/request` to the policy engine. MCP tools marked `readOnlyHint` never ask, so the engine sees them only through the hook. |
| [M2-05](https://github.com/jcore9/Aphelion/issues/31) | The Codex managed hook and `requirements.toml` above. The agent can't write `$CODEX_HOME/rules`. |
| [M0-12](https://github.com/jcore9/Aphelion/issues/14) | Unchanged in M0. M4-10 adds the pinned `codex` binary, the `/etc/codex` files and the seccomp profile, in the shape M0-18 measures. |
| [M0-18](https://github.com/jcore9/Aphelion/issues/124) | New spike on user namespaces in the container. |
