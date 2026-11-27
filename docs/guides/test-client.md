# Chat with a bot from the command line

`aphelion chat` is a small test client. You type a line, the bot answers, and you see its text as it arrives and a line for each tool it uses. It is plain lines in a terminal, with no screen layout. It is for checking that a bot works, not a replacement for the apps.

## Start a chat

1. Add a device and copy its token. The token is shown once.

   ```sh
   sudo aphelion device add chat-test
   ```

2. Start the chat on the server, in a terminal. Replace `chief` with your bot's name. A bot name is lower case letters, digits and hyphens.

   ```sh
   sudo aphelion chat chief
   ```

3. Paste the token when it asks `Device token:`. Nothing shows on screen while you paste, and the token is not saved. Ctrl-C or Ctrl-D at this prompt prints `aphelion: no device token entered` and leaves with exit status 0.

4. Type a message and press Enter.

```
Connected to chief. Type a message and press Enter. Ctrl-C cancels the turn, Ctrl-D leaves.
What files are in the current folder?
I'll look.
[tool] start Bash (shell)
[tool] end Bash: ok
There are three files: ...
[usage] in=1204 out=88 cache=900/0
[turn] completed
```

`sudo aphelion chat` needs a terminal. It refuses to run through a pipe or a script. It starts a short-lived container from the service's image, on the host's network, and connects to the server at the tailnet address in `/opt/aphelion/deploy/.env`. The chat is not inside the service's container, so a server restart doesn't end the client.

Running `aphelion chat` from your laptop needs the `aphelion` program there. Aphelion doesn't ship one in this version.

## What you see

| Line | Meaning |
| --- | --- |
| Plain text | The bot's answer, as it arrives |
| `[tool] start NAME (KIND)` and `[tool] end NAME: OUTCOME` | The bot used a tool. `KIND` is `file.read`, `file.write`, `shell`, `web` or `other`. |
| `[permission] ...` | The bot asked to use a tool, and what was decided |
| `[usage] ...` | Tokens used in the turn, and the cost when the AI tool reports it |
| `[turn] REASON` | The turn ended. The reason is `completed`, `cancelled`, `denied`, `limit`, `refused` or `error`. |
| `[error] ...` | The turn failed. This line goes to standard error. |
| `[notice] ...` | A message from the server or from the client |

Only the chosen bot's events show. The client strips control characters from the bot's text, so a bot can't move your cursor or change your terminal.

## Keys

- **Ctrl-C** during a turn cancels it. The client stays open to show `[turn] cancelled`. Ctrl-C a second time, or with no turn running, leaves. A `SIGINT` signal sent to the client, for example with `kill -INT`, does the same. If the connection drops before the cancel arrives, the client sends it again once it is back.
- **Ctrl-D** leaves after any answer in progress ends.

## When the connection drops

The client says `aphelion: lost the connection to the server, trying again`. It waits, starting at a quarter of a second and growing to 5 seconds, and tries again. It counts as back when the server has accepted the request to continue, and then it says `aphelion: connected again` and shows the events it missed, each once. A server that keeps closing the connection with an error makes the client say it once, not on every try, and the client gives up after 5 tries in a row. A message you sent just before the drop is sent again with the same ID, so the bot answers once. Nothing you type goes out before the client knows where it is in the server's history.

If the server's history was restored from a backup, so that it is a different history from the one the client knew, the client says `[notice] the server's history was restored; continuing from now` and carries on from the newest event. If the server only trimmed old events, the client carries on without a notice.

The client gives up with exit status 1 when the server refuses the token. That happens when you revoked the device or the token expired. Add a device again with `sudo aphelion device add`.

## Options

Run `aphelion chat` directly, for example in the container or on a developer machine, to use these. The [command reference](../reference/cli.md#aphelion-chat-bot) lists them.

- `--token-file PATH` reads the token from a file only you can read, so no prompt is needed.
- `--cursor-file PATH` remembers the last event shown, so a later run carries on from it.
- `--url ADDRESS` sets the server's address.
