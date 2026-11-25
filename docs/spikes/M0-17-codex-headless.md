# M0-17 finding: Codex headless on a ChatGPT login

- Issue: [M0-17](https://github.com/jcore9/Aphelion/issues/113)
- Date: 2026-11-22. Sources were read and every test ran on this date (UTC).
- Tested with: Codex CLI 0.169.0 (and 0.171.0 where marked), `@agentclientprotocol/codex-acp` 2.7.0 and 2.9.0, `@agentclientprotocol/sdk` 2.9.1, Bun 1.4.5, Docker 29.10.0, `ubuntu:26.04`, on a Debian 13 host
- Prototype: `spikes/M0-17/` on the [`spike/M0-17-codex-headless-prototype`](https://github.com/jcore9/Aphelion/tree/spike/M0-17-codex-headless-prototype/spikes/M0-17) branch, with the run logs in `runs/`. That branch is never merged.
- Decision: [0024](../decisions/0024-codex-third-bot-cli.md). This finding settles nothing. It stops for the owner on three questions, listed at the end.

## Summary

`codex app-server` runs a turn with tool calls on the owner's ChatGPT login, with no API key. The plan's five-hour window moved during the turn. With the `untrusted` approval policy, Codex sent an approval request before every shell command and file change, including `cat`.

`codex-acp` falls short. Its four fixed modes send `on-request` or `never`, so none of them asks before every command. When a root-owned `requirements.toml` allows only `untrusted`, every `codex-acp` prompt fails. `codex exec --json` can't answer approvals at all. So by the issue's table, M4-10 would speak app-server JSON-RPC directly, and a decision record would amend "ACP first" for Codex.

Three things stop for the owner:

- **Terms.** OpenAI's terms don't address one person driving their own Codex from a self-hosted program. Two Codex docs pages point automation at API keys.
- **Sandbox.** Codex's Linux sandbox can't start in the hardened container. Docker's default seccomp profile blocks the user namespace that it needs. With the sandbox required, every approved command fails.
- **`untrusted` is being retired.** The docs say it is no longer supported. Codex 0.169.0 refuses to start when `config.toml` sets it, but still honors it from `thread/start`, from a project's `trust_level` and from `requirements.toml`.

A managed `PreToolUse` hook saw every local tool call, including the ones that never asked. It is a gate that doesn't depend on `untrusted` surviving, but only a hook script that fails closed by itself is safe. Codex runs the tool when a hook crashes, times out or prints garbage.

## How the tests ran

- **One turn on the owner's login.** The run used `~/.codex` on this box, on Codex 0.169.0, with `OPENAI_API_KEY` and `CODEX_API_KEY` unset. The run log is `runs/r1-appserver-untrusted.jsonl`, with account ids redacted.
- **Everything else ran against a scripted mock.** `checks/mock_responses.py` stands in for the Responses API and makes the model call a fixed list of tools. These runs used a scratch `CODEX_HOME`, no login and no plan usage. The approval gate runs inside the Codex binary, so the mock exercises it exactly. It also makes every policy and tool repeatable.
- **The system Codex changed during the spike.** At 02:14 UTC, root replaced `/usr/bin/codex` 0.169.0 with 0.171.0, and the owner's T3 app restarted on it. After that, `~/.codex` held state written by 0.171.0. Running 0.169.0 against that state would be a downgrade, and running 0.171.0 against it was ruled out for this spike. So the one real turn was also the last. Later runs used 0.169.0 from npm (`@openai/codex@0.169.0-linux-x64`, shasum `addde1b4…` matching the registry), always with a scratch `CODEX_HOME`.

## Answers

### 1. Which headless path exists, at which version

| Path | Version | Result |
| --- | --- | --- |
| `codex app-server` (stdio JSON-RPC) | 0.169.0, 0.171.0 | Works (measured). It is the only path where every tool call can be made to ask. The [App Server docs](https://learn.chatgpt.com/docs/app-server) say it is "the interface Codex uses to power rich clients (for example, the Codex VS Code extension)". The CLI help labels it `[experimental]`. |
| `@agentclientprotocol/codex-acp` | 2.9.0 needs `@openai/codex ^0.171.0`. 2.7.0 (`^0.166.0`) is the last release before that. | Runs on Bun, and `CODEX_PATH` points it at a pinned binary (measured: 2.7.0 with 0.169.0, and 2.9.0 with 0.171.0). It starts `codex app-server` and maps it to ACP. Its modes can't make every call ask. See question 5. |
| `@zed-industries/codex-acp` | 0.16.0 | Deprecated on npm: "This package has been replaced by @agentclientprotocol/codex-acp." |
| `codex exec --json` | 0.169.0 | Runs, but can't answer approvals (measured). When a command needed approval, the stream logged "command execution approval is not supported in exec mode", and the command was rejected. |
| `codex mcp-server` | 0.169.0 | Gone (measured): "error: unrecognized subcommand 'mcp-server'". |

`codex-acp` is one bundled file (`dist/index.js`), and it ran with no `node_modules` beside it (measured). Its npm package depends on `@openai/codex`, so an install pulls in a second Codex binary (0.166.0 for 2.7.0). Without `CODEX_PATH`, the adapter runs that bundled binary (read in the 2.9.0 source), so the harness must always set `CODEX_PATH`.

`developers.openai.com/codex/*` now redirects (HTTP 308) to `learn.chatgpt.com/docs/*`. The links below use the new addresses.

### 2. Does it run on a ChatGPT login

Yes (measured), on the owner's existing login, not on a fresh Unix user.

- `codex login status` printed "Logged in using ChatGPT". `OPENAI_API_KEY` and `CODEX_API_KEY` were unset.
- `account/read` returned `"type": "chatgpt"`, `"planType": "plus"` and `"backendOrigin": "https://chatgpt.com"`.
- A turn that ran `cat hello.txt`, `echo hi > out.txt` and `curl -sI https://example.com` completed on model `gpt-6.2-sol`.
- `account/rateLimits/read` showed `limitId: "codex"` with a 300-minute window and a 10,080-minute window. The 300-minute window went from 4% to 5% used during the turn. The account had no credits (`"balance": "0"`), so the turn drew on the plan.

Not done:

- **The fresh-user test.** The issue asks for a fresh Unix user signed in with `codex login --device-auth`. This run was forbidden to log in, so it used the cached login, as M0-01 and M0-02 did.
- **The API billing check.** Checking that the OpenAI Platform usage page shows no charge needs the owner's Platform account.

### 3. Which ChatGPT plans include it

Documented. The owner's plan is Plus (measured, from `account/read`), and Plus includes the CLI.

- [Pricing](https://learn.chatgpt.com/docs/pricing): "ChatGPT Work and Codex are included in your ChatGPT Free, Go, Plus, Pro, Business, Edu, or Enterprise plan."
- Same page, Plus: "Codex on the web, in the CLI, in the IDE extension, and on iOS." Pro is "Everything in Plus and:".
- Free and Go are described only as "Explore Codex capabilities on quick coding tasks" and "Use Codex for lightweight coding tasks". The page's feature table didn't survive the fetch, so CLI access on Free, Go and Business is not determined.
- [Help Center: Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) (shown as "Updated: 17 days ago"): "Codex is included across ChatGPT plans, including Free and Go." and "Model usage counts toward your normal Codex usage limits and applicable credits or billing."

### 4. Do OpenAI's terms allow it

Not determined. The terms don't address this case. **This stops for the owner.**

- [Terms of Use](https://openai.com/policies/terms-of-use/), effective January 1, 2026: "You may not share your account credentials or make your account available to anyone else".
- Same page, among the things you may not do: "Automatically or programmatically extract data or Output".
- Same page: "circumvent any rate limits or restrictions or bypass any protective measures or safety mitigations".
- [Usage Policies](https://openai.com/policies/usage-policies/), effective November 20, 2026: an application that "enables third parties to directly access OpenAI models, you must obtain our prior review and approval." Then: "This requirement does not apply solely because an application integrates OpenAI models".
- [Service Terms](https://openai.com/policies/service-terms/), updated November 13, 2026: nothing about Codex beyond output licensing.
- [App Server docs](https://learn.chatgpt.com/docs/app-server): "App-server authentication has never been permitted for commercial or hosted services." The same page also says: "If you are automating jobs or running Codex in CI, use the Codex SDK instead."
- [Authentication docs](https://learn.chatgpt.com/docs/auth): "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs." and "API keys are still the recommended default for automation."

Aphelion is self-hosted for one person and isn't commercial or hosted, so the app-server line doesn't rule it out. But the auth page's advice to use API keys for automation is closer to Aphelion's case than anything M0-01 found for Claude. The owner settled the same question for Claude and Grok in [decision 0019](../decisions/0019-cli-subscription-use.md). Codex needs its own answer.

### 5. Does every tool call ask

Yes, on app-server, with the `untrusted` policy (measured). No preset `codex-acp` mode does it.

The table shows, for each scripted tool call, what happened on Codex 0.169.0 against the mock. "asks" means an approval request reached the client before the call ran. "runs" means it ran with no request. "hidden" means it ran or was refused with no item sent to the client at all.

| Tool call | `untrusted`, any sandbox | `on-request`, workspace-write | `on-request`, read-only | granular (all `true`), read-only | `never`, workspace-write |
| --- | --- | --- | --- | --- | --- |
| `cat hello.txt` | asks | runs | runs | runs | runs |
| `ls -la` | asks | runs | runs | runs | runs |
| `echo hi > out.txt` | asks | runs | hidden, fails `EROFS` | asks | runs |
| `curl -sI https://example.com` | asks, then fails (no network) | runs, fails | runs, fails | runs, fails | runs, fails |
| `cat /etc/hostname` with `require_escalated` | asks | asks | asks | asks | hidden, refused |
| `apply_patch` (add a file) | asks | runs | asks | asks | runs |
| MCP tool with no annotations | asks (elicitation) | asks | asks | asks | fails ("requires approval, but approval policy is never") |
| MCP tool with `readOnlyHint: true` | runs | runs | runs | runs | runs |
| Web search (hosted tool) | runs | runs | runs | runs | runs |

More measurements:

- **The real turn agrees.** Under `untrusted` with `workspace-write`, all three commands asked. That includes `cat hello.txt`.
- **0.171.0 agrees.** It behaved the same under `untrusted` on app-server.
- **Granular with workspace-write matches `on-request`.**
- **A project's `trust_level = "untrusted"` works as a default only.** It made `untrusted` the default policy. An explicit `on-request` on `thread/start` still overrode it.
- **`untrusted` in `config.toml` is refused.** Codex 0.169.0 exited with "approval_policy = "untrusted" is no longer supported; remove this setting". The [approvals docs](https://learn.chatgpt.com/docs/agent-approvals-security) say: "Codex and ChatGPT Work no longer support `approval_policy = "untrusted"`."
- **A user `allow` rule silences an approval.** With `prefix_rule(pattern = ["cat"], decision = "allow")` in `$CODEX_HOME/rules/default.rules`, both `cat` calls ran without asking under `untrusted`. That includes the escalated one, which then ran outside the sandbox.
- **Other rules.** A `prompt` rule for `ls` made it ask under `on-request`. A `forbidden` rule for `echo` didn't match `echo hi > out.txt`, because Codex matches a command with a redirect as one whole `bash -lc` script.
- **Approval answers.** Command approvals offer `accept`, `acceptWithExecpolicyAmendment` and `cancel`. The amendment option saves a lasting `allow` rule, so the harness must never pick it.

`codex-acp`, measured with 2.7.0 on 0.169.0 and 2.9.0 on 0.171.0:

| Mode | Policy it sends | What ran without asking |
| --- | --- | --- |
| `agent` (the default, "Auto review") | `on-request`, reviewer `auto_review` | Everything except escalations. In 2.9.0, the escalated `cat /etc/hostname` went to a "Guardian Review" model call, not to the client. |
| `read-only` | `on-request` | `cat`, `ls`, `curl`, the MCP read-only tool and web search. The write produced no ACP tool call. |
| `workspace-write` | `on-request` | `cat`, `ls`, the write, `curl`, `apply_patch`, the MCP read-only tool and web search |
| `agent-full-access` | `never`, `danger-full-access` | Everything. `curl` reached example.com from the host. |

The modes are hard-coded in `src/AgentMode.ts` (read in the 2.9.0 bundle). `agent-full-access` is always offered, and the adapter's default comes from `INITIAL_AGENT_MODE` or `agent`. Permission options include `allow_always` variants that save lasting grants.

### 6. Can root-owned managed config pin it

Mostly yes (measured). The container ran as uid 10001 with a root-owned, mode 644 `/etc/codex/requirements.toml` on a read-only root. The bot got "Permission denied" writing it.

| Setting in `requirements.toml` | Result |
| --- | --- |
| `allowed_approval_policies = ["untrusted"]` | Holds. A user `config.toml` asking for `never` fell back to `untrusted` with a warning. `thread/start` asking for `never`, `on-request` or granular was coerced to `untrusted` with a warning. `turn/start` asking for `never` was rejected: "invalid value for `approval_policy`: `Never` is not in the allowed set [UnlessTrusted]". |
| `allowed_sandbox_modes = ["read-only", "workspace-write"]` | Holds. `danger-full-access` from the user config or `thread/start` fell back to `read-only`. From `turn/start`, it was rejected. |
| `allowed_approvals_reviewers = ["user"]` | Holds. `auto_review` fell back to `user`. |
| `codex exec --dangerously-bypass-approvals-and-sandbox` | Coerced to `untrusted`. The command was rejected, because exec can't ask, and the file wasn't written. |
| `allow_managed_hooks_only = true` | Holds. A hook in `$CODEX_HOME/hooks.json` never ran. `hooks/list` showed the `/etc/codex/hooks.json` hook as `"isManaged": true, "trustStatus": "managed"`. |
| `[features] hooks = true` | The managed hook ran. |
| `check_for_update_on_startup = false` | Holds. A user value of `true` was overridden with a warning. |
| `allowed_web_search_modes = []` | Holds. The `web_search` tool was gone from the model's tool list, even with `web_search = "live"` in the user config. |
| `[rules] prefix_rules` with `decision = "prompt"` for `cat` | Holds. It beat the user `allow` rule, and `cat` asked again. A managed rule can't name every command, so the user `rules` folder is still a way around `untrusted`. |
| `allowed_login_methods = ["chatgpt"]` | Shown in `configRequirements/read`. It didn't stop a custom model provider that reads its key from an environment variable. Whether the requirements can pin `model_provider` is not determined. |

`codex-acp` 2.7.0 under these requirements failed every prompt, with or without a managed permission profile: "`OnRequest` is not in the allowed set [UnlessTrusted]". With `agent-full-access`, it failed on `Never`. So the bypass modes are unreachable, and so is every other mode.

The managed `PreToolUse` hook (`/etc/codex/hooks.json`, matcher `.*`):

- **It saw every local tool call.** It ran for 8 of the 9 scripted calls: five `Bash`, `apply_patch`, `mcp__probe__echo` and `mcp__probe__peek`. It also ran for calls that never asked, such as the read-only MCP tool and the `cat` let through by a user rule. It didn't run for web search. The [hooks docs](https://learn.chatgpt.com/docs/hooks) say hosted tools "don't use the local function-tool hook path".
- **Deny works.** Exit code 2, or `"permissionDecision": "deny"`, blocked the call. The client got no item for it. The model got "Command blocked by PreToolUse hook: blocked by policy."
- **It fails open.** Codex ran the tool when the hook exited 1, printed something that isn't JSON, ran past its 3-second timeout, or crashed because the harness socket was missing.
- **A strict hook fails closed.** `hook-strict.py` catches every error, has its own 2-second deadline and exits 2 on any failure. With the harness down, it blocked all 8 calls. With the harness answering `allow`, the calls went on to Codex's own approvals.

Auto-update. Requirements turn off the startup check. The npm package can't update itself in the image, because the binary is root-owned on a read-only root (inferred, not run). On this box, the system Codex did change underneath the owner's T3 app mid-spike, which shows why the image pins it.

### 7. Does it run in the hardened container

Codex runs. Its sandbox doesn't (measured). The flags were `--read-only --cap-drop ALL --security-opt no-new-privileges:true --user 10001:10001`, with tmpfs at `/tmp` and the bot home.

- **The sandbox can't start.** `codex sandbox -- true` failed with "bwrap: No permissions to create a new namespace". It failed the same way with Codex's bundled bwrap and with the `bubblewrap` package. The host allows unprivileged user namespaces (`kernel.unprivileged_userns_clone = 1`).
- **Docker's seccomp profile is the cause.** With only `--security-opt seccomp=unconfined` added, the sandbox started and blocked a write to the bot home ("Read-only file system").
- **With the sandbox required, commands fail.** Every approved command that would run in the sandbox failed with exit 1. Only escalated commands, which run outside the sandbox after approval, succeeded. `apply_patch` and MCP calls still worked. Approvals still reached the client, and the hook still ran.
- **Login inside the container is not determined.** This run was forbidden to log in. The [auth docs](https://learn.chatgpt.com/docs/auth) document `codex login --device-auth` for headless machines, and `cli_auth_credentials_store = "file"` stores `auth.json` under `CODEX_HOME`.

Egress, measured on a Docker `--internal` network, where the only way out was a logging CONNECT proxy, with `HTTPS_PROXY` and `NO_PROXY=localhost,127.0.0.1`:

- **All traffic went through the proxy.** A direct `curl` from the container failed. Every Codex connection arrived at the proxy as a CONNECT, including `wss://api.openai.com/v1/responses`, which then fell back to HTTPS.
- **Hosts seen with no login.**
  - `api.openai.com` serves the Responses API.
  - `api.github.com` serves the update check (`/repos/openai/codex/releases/latest` in the binary).
  - `codeload.github.com` serves zip downloads (`/{owner}/{repo}/zip/{ref}` in the binary).
- **Hosts a ChatGPT login needs (inferred).**
  - `chatgpt.com` (`backendOrigin` in `account/read`, and `/backend-api/codex` in the binary).
  - `auth.openai.com` (`/oauth/token` in the binary, for token refresh).
  - `ab.chatgpt.com` (`/otlp/v1/metrics` in the binary).
- **Not measured.** Login, token refresh and the ChatGPT WebSocket through the proxy. The auth docs say a custom CA set with `CODEX_CA_CERTIFICATE` applies to "login, normal HTTPS requests, and secure WebSocket connections".

**This stops for the owner.** The two ways forward each change decision 0016's security model:

1. Give the bot container a seccomp profile that allows unprivileged user namespaces, so Codex's sandbox runs inside the container.
2. Allow `danger-full-access` in `requirements.toml`, so commands run unsandboxed with `untrusted` approvals and the managed hook. The container is then the only boundary.

### 8. Resume and usage

Resume works (measured against the mock).

- **App-server.** A new `codex app-server` process ran `thread/resume` with the earlier thread id from a different working directory. The thread came back with `turns: 1`, and the next model request carried the earlier messages.
- **`codex-acp`.** A new 2.7.0 process ran `session/load`, replayed the session as `user_message_chunk` and `agent_message_chunk` updates, and sent the earlier messages with the next prompt.

Usage:

- **App-server streams the plan windows.** It sends `thread/tokenUsage/updated` after every model call, with input, cached, output and reasoning tokens. It also sends `account/rateLimits/updated` with `primary` and `secondary` windows (`usedPercent`, `windowDurationMins`, `resetsAt`) and `planType`. On the real turn, the windows were 300 and 10,080 minutes (measured). M7 can read these directly.
- **`codex-acp` doesn't forward them.** Its `usage_update` carries only `used` and `size` for the context window (measured). It reads rate limits, but only shows them as text in its status command (from the 2.9.0 source).

## Questions for the owner

1. **Terms.** Should Codex run on your ChatGPT login under the guardrails of decision 0019, or on an API key, or stay out? OpenAI's terms don't cover this case, and its auth docs recommend API keys for automation.
2. **Container sandbox.** Should the bot container get a seccomp profile that allows user namespaces, so Codex's sandbox runs? Or should Codex run unsandboxed (`danger-full-access`), with `untrusted` approvals and the fail-closed managed hook, and the container as the only boundary? Either way, it becomes a decision record.
3. **`untrusted` retirement.** M2-04's "every call asks" rests on `untrusted`, which OpenAI is retiring, and on the managed hook. Is a pinned Codex version plus the hook an acceptable basis? Or should Codex wait until OpenAI ships a supported way to ask for every call?

If the owner says yes to the first and picks an option for the second, M4-10 speaks app-server directly. That needs a decision record that amends "ACP first" for Codex.

## Downstream changes

| Issue | Change |
| --- | --- |
| [M4-10](https://github.com/jcore9/Aphelion/issues/114) | Waits on the three owner questions. If they're answered yes: speak `codex app-server` JSON-RPC directly, not `codex-acp`, with a decision record that amends "ACP first" for Codex. Pin the `codex` binary. Start every thread with `approvalPolicy: "untrusted"` and `approvalsReviewer: "user"`. Answer approvals with `accept`, `decline` or `cancel` only, never `acceptForSession` or `acceptWithExecpolicyAmendment`. Map "hook denied, no item" and "declined" onto one event. |
| [M2-04](https://github.com/jcore9/Aphelion/issues/30) | Codex sends three request types to the policy engine: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` and `mcpServer/elicitation/request`. MCP tools marked `readOnlyHint` never ask, so the engine sees them only through the hook. |
| [M2-05](https://github.com/jcore9/Aphelion/issues/31) | The Codex managed hook is required. Write it to fail closed by itself: catch every error, keep a deadline shorter than Codex's `timeout`, and exit 2. Ship `/etc/codex/requirements.toml` with the settings from question 6, plus `allowed_web_search_modes = []`. Keep the bot from writing `$CODEX_HOME/rules`, because a user `allow` rule silences `untrusted`. |
| [M0-12](https://github.com/jcore9/Aphelion/issues/14) | Unchanged in M0. M4-10 adds the pinned `codex` binary and the root-owned `/etc/codex` files, and either the seccomp profile or `danger-full-access`, depending on question 2. |
| [M1-01](https://github.com/jcore9/Aphelion/issues/19) | No change expected. App-server items map onto the contract's tool, permission, turn-end and usage events. |
| [M1-07](https://github.com/jcore9/Aphelion/issues/25) | M4-10 records an app-server stream for the contract tests. `checks/mock_responses.py` on the prototype branch can produce one without a login. |
| [M7-00](https://github.com/jcore9/Aphelion/issues/74) | The Codex collector reads `account/rateLimits/updated` and `thread/tokenUsage/updated` from app-server. |
| [0022](../decisions/0022-bot-network-boundary.md) option 2 | The egress allowlist adds `api.openai.com`, `chatgpt.com` and `auth.openai.com`. It leaves out `api.github.com` and `codeload.github.com`, which the image doesn't need once updates are off. |
| Install guide (M0-12, then M4-10) | Sign in with `codex login --device-auth` as `aphelion-bot`, with `cli_auth_credentials_store = "file"`. This step is untested. |
