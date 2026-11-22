# M0-01 finding: Claude over ACP on a subscription login

- Issue: [M0-01](https://github.com/jcore9/Aphelion/issues/2)
- Date: 2026-11-21
- Tested with: Claude Code 2.1.330, `@agentclientprotocol/claude-agent-acp` 0.109.1, `@agentclientprotocol/sdk` 2.9.1, Bun 1.4.5, Debian 13
- Prototype: `spikes/M0-03/checks/acp-probe.ts` on the [`spike/M0-03-headless-on-bun`](https://github.com/jcore9/Aphelion/tree/spike/M0-03-headless-on-bun/spikes/M0-03) branch. That branch is never merged.
- Decision: [0019](../decisions/0019-cli-subscription-use.md)

## Summary

`@agentclientprotocol/claude-agent-acp` runs a full turn with tool calls on a claude.ai subscription login, with `ANTHROPIC_API_KEY` unset. Permission requests reach the ACP client for every tool call that Claude Code would ask about. Resume works after a restart. The terms are not explicit about one person's self-hosted program, and the owner decided to proceed on the subscription ([decision 0019](../decisions/0019-cli-subscription-use.md)).

M1-02 can go ahead as planned, with two changes: the adapter must be switched out of its default `auto` mode, and read-only commands need the M2-05 hook to be seen at all.

## Answers

### 1. Which adapters exist

| Package | Version | State |
| --- | --- | --- |
| `@agentclientprotocol/claude-agent-acp` | 0.109.1 | Current. Built on `@anthropic-ai/claude-agent-sdk` 0.3.330. Requires Node 22 or later, and also runs on Bun. |
| `@zed-industries/claude-agent-acp`, `@zed-industries/claude-code-acp` | 0.23.1, 0.16.2 | Deprecated on npm and renamed to the package above. |

The ACP TypeScript SDK moved the same way: `@zed-industries/agent-client-protocol` is deprecated in favor of `@agentclientprotocol/sdk`. Version 2 of that SDK replaced the connection classes with `client()` and `agent()` builders.

### 2. Does it run on a subscription login

Yes (measured).

- `claude auth status` reported `"authMethod": "claude.ai"` on the test user. No `ANTHROPIC_API_KEY` was set.
- The adapter, run on Bun, completed a turn that called the Bash tool.
- Its `usage_update` events carry `_claude/rateLimit` with the plan's `five_hour` and `seven_day` windows, utilization and reset times. API-key billing has no such windows, so the turn drew on the subscription.
- The same events carry a `cost` amount in USD. On a subscription, that amount is an estimate and nobody is charged.
- The `claude -p` path reported `"apiKeySource": "none"`.

### 3. Do the terms allow it

Not explicitly (read 2026-11-21). The owner decided to proceed on the basis that driving the CLIs on a subscription is allowed, as other self-hosted tools do ([decision 0019](../decisions/0019-cli-subscription-use.md)). The quotes behind that decision:

- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance): "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
- Same page: "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users."
- Same page: "developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."
- Same page: the restrictions do not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription".
- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview.md): "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."
- [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), effective Oct 8, 2025, section 3: no access "through automated or non-human means, whether through a bot, script, or otherwise", except "via an Anthropic API Key or where we otherwise explicitly permit it".

The text separates developers who offer products from end users who sign in themselves. It does not address one person who runs their own copy of an open-source tool. Decision 0019 sets the guardrails that keep Aphelion on the end-user side of that line.

### 4. Does every tool call reach the client as a permission request

Partly (measured).

- **The adapter starts in `auto` mode.** `session/new` returned `currentModeId: "auto"`, with `bypassPermissions` among the available modes. In `auto` mode, `wc -c hello.txt` ran with no permission request. The test user's settings set no mode, so `auto` is the adapter's own default.
- **After `session/set_mode` to `default`**, a write (`echo hi > out.txt`) produced a `session/request_permission` with the options `allow_once`, `allow_always` and `reject_once`. Allowing created the file. Denying left no file, and the agent reported the refusal and stopped trying.
- **Read-only commands never ask.** In `default` mode, `wc -c hello.txt` still ran without a request. Claude Code auto-allows commands it classifies as read-only. The client sees them only as `tool_call` updates after the fact.

Consequences for M1-02 and M2:

- The harness sets `default` mode on every new or loaded session before the first prompt. The managed settings in the image disable `bypassPermissions` and `auto`, so the mode can't be changed back.
- The harness never chooses `allow_always`. A lasting grant is a rule in Aphelion's own policy, not in Claude Code.
- The managed `PreToolUse` hook (M2-05) is the only layer that sees every call, including read-only ones. It's required, not just a backstop.

### 5. Does resume work after a restart

Yes (measured). A new adapter process ran `session/load` with the earlier session id and answered a question about the earlier turn correctly. The load also worked when the new process ran in a different working directory. Aphelion still stores the working directory with the session id, as the plan says, because the CLI keeps its transcripts per project folder.

### 6. Does the stream-json path behave the same

Partly (measured). `claude -p --output-format stream-json --verbose --permission-mode default` ran on the subscription (`apiKeySource: none`). The write that needed permission was denied without any prompt: the result listed `permission_denials: ["Bash"]`. Print mode can only ask through `--permission-prompt-tool`, an MCP tool. M1-03 must host that tool on the harness MCP endpoint to route approvals. The stream also carries a `rate_limit_event` with the same plan windows.

## Downstream changes

| Issue | Change |
| --- | --- |
| [M1-02](https://github.com/jcore9/Aphelion/issues/20) | Use `@agentclientprotocol/claude-agent-acp`. Set `default` mode on every session. Never pick `allow_always`. |
| [M1-03](https://github.com/jcore9/Aphelion/issues/21) | Route approvals through `--permission-prompt-tool` on the harness MCP endpoint. |
| [M2-05](https://github.com/jcore9/Aphelion/issues/31) | The managed hook is the only layer that sees read-only calls. The managed settings also disable `bypassPermissions` and `auto` mode. |
| [M7-02](https://github.com/jcore9/Aphelion/issues/76) | Read the plan windows from `_claude/rateLimit` in ACP usage updates, or from `rate_limit_event` in stream-json. That's a better source than the undocumented endpoint or the status line. |
