# M0-02 finding: Grok headless billing

- Issue: [M0-02](https://github.com/jcore9/Aphelion/issues/3)
- Date: 2026-11-21
- Tested with: Grok Build 1.0.92, `@agentclientprotocol/sdk` 2.9.1, Bun 1.4.5, Debian 13
- Prototype: `spikes/M0-03/checks/acp-probe.ts` on the [`spike/M0-03-headless-on-bun`](https://github.com/jcore9/Aphelion/tree/spike/M0-03-headless-on-bun/spikes/M0-03) branch. That branch is never merged.
- Decision: [0019](../decisions/0019-cli-subscription-use.md)

## Summary

`grok agent stdio` speaks ACP and runs a full turn with tool calls on the owner's cached Grok login, with no `XAI_API_KEY`. It sends a permission request for each command, and resume works after a restart. xAI's docs don't say whether headless use draws on the subscription's weekly pool, and the terms page couldn't be read. The owner decided to proceed on the subscription ([decision 0019](../decisions/0019-cli-subscription-use.md)).

M4-01 can go ahead as planned.

## Answers

### 1. Does `grok agent stdio` run on the subscription login

Yes (measured).

- No `XAI_API_KEY` was set. `~/.grok/auth.json` held only a cached `auth.x.ai` session.
- `initialize` listed the auth methods `cached_token` and `grok.com`, and needed no `authenticate` call.
- A turn that ran a shell command completed, both from `bun` and from a compiled binary.

### 2. Does it draw on the weekly pool

Not shown (inferred, not measured).

- Grok's ACP stream sends no usage or rate-limit events.
- `grok usage` outside the TUI printed "`grok usage` can't show your plan's usage here yet. Run /usage inside grok instead."
- The [FAQ](https://docs.x.ai/grok/faq) says "You can use the weekly usage pool across any combination of Grok products", and that Settings → Usage shows "A percentage breakdown by product (API, Build, Chat, image & video generation, Voice)."

The test turns used the cached login and no API key, so they most likely counted against **Build** in that breakdown. The owner can confirm it by checking Settings → Usage.

### 3. Which tiers include headless use

Not stated. The [headless guide](https://docs.x.ai/build/cli/headless-scripting) assumes "`grok` is already authenticated locally, or `XAI_API_KEY` is set". No page found lists headless or ACP use by plan.

### 4. Do the terms allow it

Not determined. `https://x.ai/legal/terms-of-service` returned HTTP 403 to the fetch, and no docs page addresses self-hosted personal use. The owner decided to proceed ([decision 0019](../decisions/0019-cli-subscription-use.md)).

### 5. Permissions, auto-update and managed settings

Measured unless marked.

- **Every command asked.** A write (`echo hi > out.txt`) produced a `session/request_permission` with the options `allow_always`, `allow_once`, `reject_once` and `reject_always`.
- **Allow and deny both work.** Allowing created the file. Denying left no file and ended the turn with `stopReason: "cancelled"`. Claude, by contrast, keeps the turn going after a denial. The M4-01 adapter has to map both behaviors onto one event.
- **No mode to switch.** `session/new` returned no modes, so Grok asks by default. The harness must still never pass `--always-approve`.
- **Auto-update.** `auto_update = false` was not set in `~/.grok/config.toml`. The image (M0-12) sets it in system config.
- **Managed settings.** `/etc/grok/requirements.toml` doesn't exist on this machine, so whether stdio mode honors it is untested. M2-05 tests it inside the image (not measured).
- **Resume works.** A new `grok agent stdio` process loaded the earlier session with `session/load`, replayed it, and answered a question about the earlier turn correctly.

## Downstream changes

| Issue | Change |
| --- | --- |
| [M4-01](https://github.com/jcore9/Aphelion/issues/44) | Run `grok agent stdio` on the cached login. Map "denied, turn cancelled" onto the same event as Claude's "denied, turn continues". Never pick `allow_always` or `reject_always`. |
| [M0-12](https://github.com/jcore9/Aphelion/issues/14) | Set `auto_update = false` in Grok's system config in the image. |
| [M2-05](https://github.com/jcore9/Aphelion/issues/31) | Test that `grok agent stdio` honors `/etc/grok/requirements.toml` and the managed hook. |
| [M7-03](https://github.com/jcore9/Aphelion/issues/77) | ACP gives no usage data, so estimate from token counts as planned, calibrated against Settings → Usage. |
