# 0020. 1Password works like Grok Bot's, built on a service account

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner
- Amended by: [decision 0042](0042-plugin-server-and-client-parts.md) (a plugin never receives a value; the host injects it only into the operation it makes for the plugin), [decision 0050](0050-bootstrap-key-is-the-store-key.md) (the bootstrap secret is the local store's age key, not the service account token)
- Amends: the plan's "Secure entry, like Grok Bot's secure forms" (first-use approval per connector), and M0-15

## Context

The owner wants Aphelion's 1Password integration to work like the one in Grok Bot. Grok Bot uses [1Password for Agents](https://support.1password.com/1password-for-agents/), read on 2026-11-21:

- You connect it once with an OAuth sign-in to your 1Password account.
- When the agent needs to sign in, 1Password prompts you with which agent is asking and a suggested item. You approve that exact item in the 1Password app.
- "Your approval for Grok Bot to use a login expires after 30 days."
- 1Password fills the login into the agent's browser "outside the agent's view". The agent never sees the value.
- You can disconnect, which "deletes the connection's keys, every associated approval".

That product doesn't fit Aphelion v1:

- It's open only to partners that "have signed an agreement ... and passed a security review". Others join a waitlist.
- It covers only website logins, filled into a browser, and Aphelion v1 has no browser.
- It requires the 1Password app on the same device as the agent, which a headless container doesn't have.
- 1Password's Credential Broker (public preview) targets CI workflows with OIDC identity and a Business account, not a long-running personal server.

## Options

1. Build the same experience on 1Password's generally available service accounts: per-item approval, 30-day expiry, revocation, and values never shown to bots.
2. Wait for 1Password for Agents partner access.
3. Keep M0-15 as planned: a service account plus one approval per connector the first time.

## Decision

Option 1.

**Connecting.** A read-only 1Password service account, limited to one vault (for example "AI Agents"), is the broker's bootstrap secret ([0016](0016-one-docker-container.md), M0-14c). Its token is entered on the host and never passes through chat, a bot or the server's database.

**Asking.** The first time a consumer needs an item, the broker refuses the read and the server raises an approval. A consumer is a connector, plugin or custom MCP server acting for a named bot. The approval names:

- the bot the request is for, and the connector or plugin asking;
- the item, by its 1Password title and vault, never its value;
- the tool call or action that needs it.

**Granting.** The owner picks **Allow for 30 days** (the default, matching Grok Bot), **Allow once**, or **Deny**. A grant covers one consumer, one bot and one item, so a new bot or a new item asks again.

**Using.** The broker resolves the value inside its own process and injects it into the consumer's request, environment or headers. Bots never receive it ([0012](0012-secrets-broker-process.md)).

**Revoking.** The owner can list grants, revoke any one, or disconnect 1Password. Disconnecting deletes the service-account token and every grant. Grants expire on their own after 30 days. Every grant, use, expiry and revocation goes to the audit log.

**Later.** Aphelion joins the 1Password for Agents waitlist. If it ever gets a browser, website logins go through that product, as the plan's "Website logins (later)" section already says.

## Consequences

- The plan's "approve once or always per connector" becomes per item, per consumer and per bot, with a 30-day default. That's more prompts at first and none for 30 days after.
- In M0 there are no approval cards yet. M0-15 builds the grant model, refuses anything ungranted, and takes grant decisions through the CLI. M2-06 turns them into `approval.requested` events, and the M5 Connections page lists and revokes them.
- The service account can read everything in its one vault, so the owner keeps only what bots may use in that vault. The install guide says so.
- If 1Password opens a general agent-credential API, this record is revisited.
