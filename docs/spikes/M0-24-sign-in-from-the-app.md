# M0-24 finding: signing in to AI tools from the app

- Issue: [M0-24](https://github.com/jcore9/Aphelion/issues/173)
- Date: 2026-11-24. Sources were read and every test ran on this date (UTC).
- Status: final. The owner decided the direction on 2026-11-24. No live sign-in was run, and none is planned for this spike.
- Tested with: Claude Code 2.1.330 (the M0-01 pin) and 2.1.331 (current `latest`), Grok Build 1.0.92 (the M0-02 pin, and still the current `latest`), Codex CLI 0.169.0 (the M0-17 pin), 0.171.0 (installed on the box) and 0.172.0 (current), Docker 29.10.0, the `aphelion:local` image (Ubuntu 26.04.1), run as `aphelion-bot`, on a Debian 13 host
- Prototype: none in the repo. Throwaway scripts and the full logs stay outside it. The excerpts below are redacted.
- Decisions: [0019](../decisions/0019-cli-subscription-use.md) (unchanged, apart from one corrected command name), [0035](../decisions/0035-codex-login-sandbox-approvals.md), [0049](../decisions/0049-ai-tools-installed-from-a-list.md).

Each answer is labeled **measured** (run on this box), **docs** (read in a source, which is linked) or **inferred** (reasoned from the two).

## Summary

The issue asked whether the owner can sign in to Claude Code, Grok Build and Codex from the Aphelion app, without opening a shell in the container.

**The owner chose a sign-in guide with a status light, not a sign-in panel.** The app shows each tool's own login command and a yes or no light. The owner still opens a shell to sign in. That is the cost, and it is what the issue hoped to avoid. In return, Aphelion never runs a login, never sees a code and never reads a token file, so decision 0019 stays as written.

- **The command in decision 0019 is wrong for Claude.** There is no `claude login`. The command is `claude auth login` (measured). This PR corrects 0019.
- **The status light is possible for Claude and Codex, and pending for Grok.** Claude and Codex each have a status command that exits with 1 when signed out (measured). Grok 1.0.92 has none that I found, and its best candidate exits 0 when signed out, so Grok's light needs another way to tell (section 2).
- **Whether sign-in works inside the container as `aphelion-bot` is not determined.** The first prompt of each tool appears there (measured). No sign-in was completed. **Update, 2026-11-24:** the M0 exit test ([#187](https://github.com/jcore9/Aphelion/issues/187)) determined it for Claude Code 2.1.331. Grok and Codex stay undetermined.
- **The terms of the three vendors do not decide this.** The owner runs the official tool in a shell. Section 3 records what each vendor's terms say, for any future panel.
- **Other apps do both.** T3 Code opens its own terminal with the login command ready, which is close to the owner's choice. Three apps relay the pasted code. The public sources I read show no action by Anthropic against them.

## Owner's decisions

Made on 2026-11-24.

1. **No sign-in panel. A sign-in guide plus a status light.** The app gets a page. For each installed tool it shows the exact command to run in a shell in the container as `aphelion-bot`, for example `sudo docker compose exec --user aphelion-bot aphelion grok login --device-auth`. It also says what the owner will see. Next to it is a signed in or not light for Claude and Codex. Grok's light is pending until a reliable status command is verified (section 2). Aphelion gets the light by running the tool's own status command and showing only yes or no. Aphelion never runs a login, never sees or relays a code, and never reads a token file. Decision 0019 stays as written, so there is no decision record 0060. The owner's reason: walking the user through signing in with the CLI themselves makes the terms and token-handling questions go away.
   - **The trade-off.** The owner still opens a shell. That is what the issue hoped to avoid.
2. **No live sign-in.** The owner stopped the live Grok run before approving it and dropped the live Codex run. Signing in inside the container as `aphelion-bot` is therefore not determined. The guide's first real use shows it, in [#155](https://github.com/jcore9/Aphelion/issues/155) or the M0 exit test. M0-17 already listed "login inside the container is not determined".
   - **Update, 2026-11-24:** the M0 exit test ran Claude's sign-in. See "What stays undetermined".
3. **OpenCode is out of scope.** It stays open for #155.

## Words used here

- **Headless.** A machine with no desktop or browser of its own, such as Aphelion's server.
- **Token.** A secret the tool keeps in a file after sign-in. Whoever holds the file can use the account.
- **Device-code flow.** A sign-in for machines with no browser. The tool prints a short code and a web address. You open the address on any device and type the code. The tool waits until you finish.
- **Loopback callback.** A sign-in where the tool starts a tiny web server on its own machine and the browser is sent back to it. This fails when the browser runs on a different machine than the tool.
- **Pseudo-terminal.** A program that acts as a terminal for another program. A server holds one end, and the tool thinks a person is typing.
- **Status command.** A command that reports whether the tool is signed in, and exits with a code. 0 means success and anything else means failure.

## How the tests ran

- **Container.** Each run was a throwaway `aphelion:local` container, started as `aphelion-bot` (UID 10002). Its home was a fresh, empty, temporary folder held in memory, so nothing survived the run. The only mount was the folder holding the tool binaries, read-only. No real `~/.claude`, `~/.codex`, `~/.grok` or `~/.config` was mounted, copied or read. Every container was removed afterward.
- **Tools.** The image ships no AI tool ([0049](../decisions/0049-ai-tools-installed-from-a-list.md)). The pinned versions were the binaries installed on the host, mounted read-only. The current Claude Code and the Codex 0.169.0 and 0.172.0 binaries came from `npm install` into a scratch folder.
- **First prompt only.** Every login run stopped at the tool's first prompt and ended with Ctrl-C and a container kill. Nobody signed in. One obviously bogus string went to the input for each tool.
- **Status commands.** Each ran once, with no terminal and no input, in a fresh empty home and no sign-in.
- **Redaction.** Every saved login line went through a filter. It keeps a URL's host and path, drops query values and replaces device codes.
- **Not covered.** Claude Code 2.1.331 and Codex 0.169.0 and 0.172.0 got the first-prompt capture without the bogus string. Claude Code 2.1.331 and Codex 0.172.0 also ran the signed-out status command. Grok 1.0.93 (`alpha`) was not tested. A successful sign-in without a terminal was not tried for any tool, so it is undetermined.

## Answers

### 1. How does each tool sign in

| | Claude Code | Grok Build | Codex CLI |
| --- | --- | --- | --- |
| Command for the guide | `claude auth login` | `grok login --device-auth` | `codex login --device-auth` |
| Flow | Browser, then a **pasted code** | Device code | Device code |
| Owner types back | The code the browser shows, which has a `#` in it | Nothing | Nothing |
| First prompt without a terminal | Appears (measured) | Appears (measured) | Appears (measured) |
| Credentials | `~/.claude/.credentials.json`, mode `0600` (docs) | `~/.grok/auth.json` (docs, M0-02) | `$CODEX_HOME/auth.json`, default `~/.codex`, when `cli_auth_credentials_store = "file"` (docs) |

Same commands on the current releases: Claude 2.1.331, Grok 1.0.92, Codex 0.169.0, 0.171.0 and 0.172.0 (measured).

**The command in decision 0019 is wrong for Claude.** `claude login` is not a command. `claude auth --help` lists `login`, and `claude login --help` printed the main help, so the word was read as a prompt (measured, 2.1.330).

**What the owner sees.** The guide can tell the owner this.

*Claude Code* (measured):

```text
Opening browser to sign in…
If the browser didn't open, visit:
https://claude.ai/oauth/authorize?<REDACTED-QUERY>
Paste code here if prompted >
```

The owner opens the address on their own device, signs in, and pastes the code the browser shows into the shell. A made-up string was refused at once with "That doesn't look like the full code. Copy all of it, including the # in the middle." (measured). That is a format check inside the tool. A well-formed but wrong code was not tried. Anthropic's own docs describe the paste step ([Authentication](https://code.claude.com/docs/en/authentication), docs).

*Grok Build.* The recorded run used plain `grok login`. In a container with no browser it chose the device flow by itself and printed (measured):

```text
To sign in, open this URL in your browser:

  https://accounts.x.ai/oauth2/device?<REDACTED-QUERY>

Confirm this code in your browser:

  <REDACTED-USER-CODE>

Waiting for authorization...
```

`--device-auth` is in `grok login --help` as the way to force this flow (measured help text). The guide uses it so the tool does not have to guess. The flag itself was not run. The xAI docs list "SSH sessions, containers, headless hosts" under device code ([Grok Build authentication](https://docs.x.ai/build/enterprise#authentication), docs). `grok login --oauth` is the loopback flow. It asks for a pasted address, and it wrote `~/.grok/auth.json` within seconds, before any sign-in (measured, file name only). The guide does not use it.

*Codex CLI.* `codex login --device-auth` printed this, the same on 0.169.0, 0.171.0 and 0.172.0 (measured):

```text
Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   <REDACTED-USER-CODE>

Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.
```

Plain `codex login` is the loopback flow on `http://localhost:1455`. A browser on another machine cannot reach it, and the tool says "On a remote or headless machine? Use `codex login --device-auth` instead." (measured). The docs call device-code login a beta and say it must be enabled first: "Enable device code login in your ChatGPT security settings (personal account) or ChatGPT workspace permissions (workspace admin)." ([Codex authentication](https://learn.chatgpt.com/docs/auth), docs). The guide must say so. Decision 0035 already sets `cli_auth_credentials_store = "file"`.

**Claude's other modes stay out of the guide.** `claude setup-token` prints a one-year token to the screen (docs, measured). It puts a lasting secret where Aphelion's tools could capture it. `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` skip sign-in (docs). An API key can come through the secrets broker, as 0019 already allows.

### 2. Do 0019's rules still hold

0019 says Aphelion "never asks for, reads, copies, logs or transmits the CLIs' tokens".

**Yes, as written, with the guide and the light (inferred from the design).**

- **The guide runs nothing.** It is text. The owner types the login command in their own shell. Aphelion sees no code, no address and no token.
- **The light runs one command.** It runs the tool's status command as `aphelion-bot`. The tool reads its own credential file. Aphelion sees only the output, and keeps only yes or no.
- **No token file is opened by Aphelion.** The server user is `harness`, which is in the `aphelion-bot` group. Whether `harness` can read each tool's file depends on its mode. Claude's is `0600`, which means only the file's owner can read or write it (docs). Grok's and Codex's modes are unverified. The status design does not rely on the mode, because Aphelion never opens the file. The bot runner that starts the status command is future work (M1-04).
- **Every bot can already read these files.** All bots run as the same `aphelion-bot` ([0006](../decisions/0006-shared-bot-user.md)). The guide does not change that. The install guide should say it plainly.

**What the status commands print signed out (measured).** Each ran as `aphelion-bot` in a fresh empty home with no sign-in, no input and no terminal.

| Tool | Command | Exit code | Prints when signed out |
| --- | --- | --- | --- |
| Claude Code 2.1.331 | `claude auth status` | 1 | JSON: `"loggedIn": false`, `"authMethod": "none"`, and the config paths |
| Claude Code 2.1.331 | `claude auth status --text` | 1 | `Not logged in. Run claude auth login to authenticate.` |
| Codex 0.172.0 | `codex login status` | 1 | `Not logged in` |
| Grok Build 1.0.92 | `grok models` | 0 | `You are not authenticated.`, then a model list |
| Grok Build 1.0.92 | `grok usage` | 1 | An error saying `grok usage` can't show plan usage here yet |

- **Grok 1.0.92 has no status command that I found.** `grok --help` lists no `status` or `whoami`. `grok models` is the best candidate found. It exits 0 when signed out, so the light would have to match its text, which is fragile. `grok usage` is not usable here. What `grok models` prints signed in is not determined. The light for Grok stays open until the guide's first real use, or until a reviewer finds a better command.
- **What a signed-in status prints is not determined.** The docs say `claude auth status --text` prints a `Sign-in ends:` line, and that Claude's `/status` shows `Organization` and `Email` rows (docs). They do not say what `auth status` or `codex login status` print signed in. Assume either may show an email or account name. The light must not show it. For Claude and Codex, Aphelion keeps the exit code and drops the output, and logs none of it. Whether the exit code also tells signed in apart from other failures, such as no network, is checked at the first real sign-in.
- **Network use of the status commands was not measured.**

### 3. What the vendors' terms say

All pages were fetched and read on 2026-11-24. The guide does not depend on these verdicts, because the owner runs the official tool in a shell. They matter if the app ever carries a code, so they are recorded here.

#### Anthropic: unclear, risk on "no"

- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) (docs): "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."
- Same page: "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?* above."
- That section says: "Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms of Service and complying with the conditions below:". This is a standing question for Aphelion running Claude Code on a subscription. 0019 already accepts it. The guide does not add to it.
- Same page: "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."
- [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), effective Oct 8, 2025: "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else. You also may not make your Account available to anyone else." Under what you may not do: "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise." That clause is the open point from M0-01.

**For an app that carries the pasted code:** unclear. "Intermediate" can mean a relay, and the paste is the one item Anthropic could call a credential. The "end user" sentence names signing in to the binary and does not say a third-party screen may carry the code. The other apps' precedent (below) does not move this to allowed.

#### xAI: not ruled out

xAI is now named SpaceXSI on its legal pages.

- [Terms of Service, Consumer](https://x.ai/legal/terms-of-service), last updated October 27, 2026: "You may not share your account credentials or make your account available to anyone else".
- [Acceptable Use Policy](https://x.ai/legal/acceptable-use-policy), effective August 14, 2026, lists "Accessing the Services through unauthorized automated or non-human means, whether through a bot, script, or otherwise". The word "unauthorized" leaves room for the CLI. This is a standing question for every Grok bot under 0019.
- [Grok Build docs](https://docs.x.ai/build/enterprise#authentication): device code is for "SSH sessions, containers, headless hosts", and "Grok prints a URL and a short user code. Complete login on any device with a browser."
- I found no wording on who may show or relay a sign-in prompt. That is "not ruled out", not "allowed". `grok login --oauth` and its pasted address are a different case, also not covered.

#### OpenAI: unclear for an app that shows the code

- [Terms of Use](https://openai.com/policies/terms-of-use/), effective January 1, 2026: "You may not share your account credentials or make your account available to anyone else". Under what you cannot do: "Automatically or programmatically extract data or Output".
- [Codex authentication](https://learn.chatgpt.com/docs/auth): "In these situations, prefer device code authentication (beta)." The situations are a remote or headless environment or a blocked localhost callback. The docs also say: "API keys are still the recommended default for automation."
- The CLI itself says: "If a website or another person gave you this code, cancel." An app that shows the code is a website that gives the code. That is why the verdict is unclear.
- [App Server](https://learn.chatgpt.com/docs/app-server): "App-server authentication has never been permitted for commercial or hosted services." The same page, under Auth endpoints: "If you've built a local or open-source application using Codex app-server authentication, you can continue using it, though we recommend migrating to Sign in with ChatGPT so users have greater control over and visibility into their usage." This is about the app-server's own login calls, not the CLI's `codex login`. It sits under decision 0035's terms note, and the guide does not touch it.
- The same page mentions "Sign in with ChatGPT" for developers, with a partner waitlist. I did not read its terms. It is an option for later.

| Vendor | App that carries or shows a code | Owner runs the CLI in a shell |
| --- | --- | --- |
| Anthropic | Unclear, risk on "no" | The "end user" sentence names this case (inferred) |
| xAI | Not ruled out | Nothing in the terms against it |
| OpenAI | Unclear | The docs name the command for headless hosts |

#### What other apps do

Research from 2026-11-24, from public code and docs only. Nothing was signed in.

| App | Claude sign-in | Source |
| --- | --- | --- |
| T3 Code v0.1.11 | Opens its own terminal with `claude auth login` ready. It has no separate form for a pasted code. | [providerReadiness.logic.ts:77](https://github.com/pingdotgg/t3code/blob/d7ae1e17915c40602e7eb47dce27a6a36167f4c4/apps/web/src/onboarding/providerReadiness.logic.ts#L77), [welcome-page.md:31](https://github.com/pingdotgg/t3code/blob/d7ae1e17915c40602e7eb47dce27a6a36167f4c4/docs/user/welcome-page.md#L31) |
| Orca v1.4.273 | Panel. The server runs `claude auth login --claudeai`, the app shows the link, the pasted code goes to the tool. | [claude-pasted-code-login.ts:42-92](https://github.com/stablyai/orca/blob/824d3750c5f6634f9bb081cb26cc82612e8d08e1/src/main/claude-accounts/sign-in/claude-pasted-code-login.ts#L42-L92) |
| Openbot | Same relay. It also has a local Connect button. | [provider-terms.md:22-28](https://github.com/nightly-labs/openbot/blob/a771a57f792f28cc285772380f721e53c962493f/docs/provider-terms.md#L22-L28), [:54-64](https://github.com/nightly-labs/openbot/blob/a771a57f792f28cc285772380f721e53c962493f/docs/provider-terms.md#L54-L64) |
| OpenMausBot | Same relay on a hosted server. Its Docker docs say to run `claude` inside the container. | [claude-login-auth.ts:1-5, 144-163](https://github.com/milind-soni/OpenMausBot/blob/77bfd58b94b6d45c824f9e6fcd40cbb21912aa1d/server/drivers/claude-login-auth.ts#L1-L5), [self-hosting.md:493-498](https://github.com/milind-soni/OpenMausBot/blob/77bfd58b94b6d45c824f9e6fcd40cbb21912aa1d/docs/self-hosting.md#L493-L498) |

- **T3 Code is close to what the owner chose.** It opens its own terminal with `claude auth login` ready and has no separate form for a pasted code. On a phone this costs usability: a user could not copy the login URL out of the terminal ([issue #15453](https://github.com/pingdotgg/t3code/issues/15453)).
- **Three apps relay the pasted code.** All are public and still shipping. Openbot rates its own relay "Higher" risk and says Anthropic has not confirmed it is allowed.
- **In the public sources I read, I found no sign that Anthropic approved or acted against any of them.** That is absence of evidence, not permission. It does not move the Anthropic verdict above.
- **T3 Code reads Claude's credential file.** It reads `<configDir>/.credentials.json` and calls Anthropic's usage endpoint for usage numbers. Decision 0019 forbids Aphelion to do this.
- None of the four uses its own sign-in client ID. Each sign-in ends with the token in the tool's own file. What else each app does with that file was not checked, apart from T3 Code's read above.

### 4. Does it fit the plan's scope

The plan says "Aphelion has no code editor, diff viewer or terminal UI, and doesn't try to".

**The guide page with a status light is not a terminal UI.** It sends no input to any process and shows no output stream. It is a page of fixed text and one yes or no per tool. The only process Aphelion starts is the status command, and it keeps only the answer (inferred).

A sign-in panel was the closer call. It would have taken input for a process, which is how a terminal begins. The owner's choice avoids that question.

### 5. Would it change outside the container

Aphelion's host is a headless server. The owner reaches it over Tailscale from another device ([plan](../plan/aphelion-plan.md), [install guide](../guides/install.md)). It is not the owner's desktop. Two cases need separating.

**The headless host, with the tools in the container or on the host.**

- **Nothing changes for sign-in** (inferred). The owner's browser is on another device in both cases.
- **Loopback sign-in fails** without port forwarding, as it does in the container.
- **Device flows still help.** Grok and Codex print an address and a code the owner opens on any device. Claude's paste flow works the same way.
- **The terms don't change.** They do not mention containers, and the Anthropic page says the "end user" sentence holds "including where a platform hosts Claude Code".
- **Where credentials land can differ.** Claude uses the encrypted Keychain on macOS, and Codex `auto` uses the OS credential store when one exists (docs). Decision 0035's `file` setting gives a known path.

**A possible local runtime on the owner's own machine ([#174](https://github.com/jcore9/Aphelion/issues/174) will review it).**

- The browser and the tool share a machine, so loopback sign-in works with no code and no guide.
- The owner's own terminal is already there.
- Isolation is weaker. Credentials sit in the owner's home, readable by anything running as the owner (inferred).
- #174's own text agrees. It says Aphelion "must leave credentials with the vendor CLI" and that a runtime needing its own login has the user "sign in once through the vendor's official terminal flow".

## Options considered

1. **Shell only.** No page. Fix the `claude login` typo.
2. **Guide plus status light. Chosen by the owner.** Section 2 and the decisions above.
3. **Display-only panel for device-code sign-ins, Grok and Codex.** Aphelion runs the login and shows the address and code. Not chosen. A device code is sensitive. The CLIs warn about it ("Don't share it with anyone." for Grok, "If a website or another person gave you this code, cancel." for Codex). A future panel must never log or keep it.
4. **Full panel with a pasted-code field, Claude included.** Not chosen. It needs Anthropic to confirm in writing and a change to 0019.
5. **Wait for #174.** Helps only if a local runtime exists. The headless host still needs the guide.

## What stays undetermined

- **Sign-in inside the container as `aphelion-bot`.** Whether each tool finishes, where its file lands, its owner and mode, and whether the device flows survive a closed shell. The guide's first real use shows it. Run it in #155 or the M0 exit test, and check each file by owner, mode and size only.
  - **Update, 2026-11-24: determined for Claude Code 2.1.331 by the M0 exit test ([#187](https://github.com/jcore9/Aphelion/issues/187); [results](../plan/milestones/M0-exit-test.md#claude-sign-in-inside-the-container)).** Sign-in as `aphelion-bot` worked with the paste-code flow. The file was `aphelion-bot aphelion-bot 600`. `harness` and `aphelion-plugins` could not read it. A `claude -p` request completed. Grok and Codex stay undetermined.
- **What each status command prints signed in.** Check that no email or account name leaks into Aphelion's logs.
- **Grok's status command.** The light for Grok waits on this.
- **Codex's ChatGPT setting.** What the failure looks like when device-code login is not enabled.

## Downstream changes

| Issue | Change |
| --- | --- |
| [#155](https://github.com/jcore9/Aphelion/issues/155) | Each tool's list entry carries its login command and its status command. Use `claude auth login`, not `claude login`. OpenCode's login was not checked and stays open. |
| [#174](https://github.com/jcore9/Aphelion/issues/174) | Feeds the exit review. Section 5 is the input. |
| [Install guide](../guides/install.md) | Sign-in steps per tool, written later with #155, not in this PR. Say Codex's device-code login must be enabled in ChatGPT's security settings first. Say every bot can read the saved logins. |
| [Decision 0019](../decisions/0019-cli-subscription-use.md) | Command corrected in this PR. Nothing else changes. |
| The app's guide page | A future web-client issue, filed only if the owner asks. |
| [#178](https://github.com/jcore9/Aphelion/issues/178) | A server command that hides Docker. Once it lands, the guide shows `sudo aphelion sign-in <tool>` instead of the `docker compose exec` line. |
