# Config reference

The server reads its config from `/etc/aphelion/` ([decision 0014](../decisions/0014-filesystem-layout.md)). Code that runs in development passes another directory to `loadConfig`. Bots can't read or write this directory. They change bot entries only through the bot management tools ([decision 0010](../decisions/0010-bot-folders.md)).

## Layout

```
/etc/aphelion/          owner harness, mode 0750 or tighter
  bots.yaml           what each bot is allowed to do
  policy.yaml           approval rules (no fields yet, M2-01)
  routines.yaml         routines (no fields yet, M6-02)
  connectors.yaml       connector settings (no fields yet, M3)
  server.yaml           the address and port the server listens on
```

All five files must exist. The directory can be a git repo. [`example/`](https://github.com/jcore9/Aphelion/tree/main/docs/reference/config/example) holds a complete, valid directory, and a test loads it.

## File format

Each file is one YAML 1.2 document whose top level is a mapping. A key that appears twice in one mapping is an error. Unknown fields are errors too, so a misspelled field name never goes unnoticed.

Every file starts with a `version` field:

```yaml
version: 1
```

## Versions and migrations

Each file has its own version. When a file's format changes, its version goes up by one, and the server gains a migration that moves the old version forward. On load, the server runs the migrations in memory, from the file's version up to the current one. Then it checks the result against the current schema. It doesn't rewrite the file. `loadConfig` returns the list of migrated files, so the caller can report them.

A file with a version newer than the server reads is an error. Upgrade Aphelion to read it.

Every file is at version 1, and no migrations exist yet.

## Owners and modes

`checkConfigPermissions` refuses a config directory that bots could read or write. [`aphelion config check`](cli.md#aphelion-config-check) calls it, and `aphelion --headless` doesn't start when it fails. Both also check the state folder, `/var/lib/aphelion`, with `checkStatePermissions`. The state folder must be owned by the server's user and group, with a mode no looser than `0700`.

| Path | Must be | Owner and group | Mode no looser than |
| --- | --- | --- | --- |
| `/etc/aphelion/` | a directory | the server's user and group | `0750` |
| Each of the five files | a regular file, not a symlink | the server's user and group | `0644` |

The files may be `0644`, the mode git checks files out with, because only the server's user and group can enter the directory. The check doesn't look inside a `.git` folder.

## Errors

Each error names the file, then the line and column where the parser found it, then the field. The line and column are left out when the file has no such position, for example when a field is missing from the top level.

```
/etc/aphelion/bots.yaml:5:12: bots[0].model: Invalid input: expected string, received number
```

| Cause | Example message |
| --- | --- |
| YAML syntax | `bots.yaml:4:1: Sequence item without - indicator` |
| A key twice in one mapping | `bots.yaml:2:1: Map keys must be unique` |
| Aliases that expand without limit | `bots.yaml: Excessive alias count indicates a resource exhaustion attack` |
| A missing file | ``bots.yaml: is missing. Create it with the line `version: 1`.`` |
| An empty file | `bots.yaml: must be a YAML mapping with a version field` |
| No `version` | `bots.yaml: version: is required` |
| A version newer than the server reads | `bots.yaml:1:10: version: must be a whole number from 1 to 1, the newest version this Aphelion reads` |
| A missing field | `bots.yaml:3:5: bots[0].model: is required` |
| An unknown field | `bots.yaml:9:12: bots[0].modle: unknown field` |
| A name that can't be a folder name | `bots.yaml:3:11: bots[0].name: must be 1 to 63 lowercase letters, digits or hyphens, starting with a letter` |
| An address that isn't an IP address | `server.yaml:2:10: address: must be an IPv4 or IPv6 address, such as 0.0.0.0` |
| A port outside 1 to 65535 | `server.yaml:3:7: port: must be from 1 to 65535` |
| A relative folder | `bots.yaml:8:13: bots[0].folder: must be an absolute path` |
| Two bots with one name | `bots.yaml:9:11: bots[1].name: duplicates bots[0].name "triage"` |
| A directory mode looser than 0750 | `/etc/aphelion: has mode 0755, which is looser than 0750` |
| A file that group or others can write | `/etc/aphelion/policy.yaml: has mode 0664, which is looser than 0644` |
| A config file that is a symlink | `/etc/aphelion/policy.yaml: must be a regular file, not a symlink` |
| The wrong owner | `/etc/aphelion: is owned by uid 4242, not the server's uid 1001` |

## JSON Schema for editors

Each file has a generated JSON Schema (draft-07) in [`config/`](https://github.com/jcore9/Aphelion/tree/main/docs/reference/config). The files are [`bots.schema.json`](https://github.com/jcore9/Aphelion/blob/main/docs/reference/config/bots.schema.json), [`policy.schema.json`](https://github.com/jcore9/Aphelion/blob/main/docs/reference/config/policy.schema.json), [`routines.schema.json`](https://github.com/jcore9/Aphelion/blob/main/docs/reference/config/routines.schema.json), [`connectors.schema.json`](https://github.com/jcore9/Aphelion/blob/main/docs/reference/config/connectors.schema.json) and [`server.schema.json`](https://github.com/jcore9/Aphelion/blob/main/docs/reference/config/server.schema.json). The schemas describe the current version. An editor that runs the YAML language server can then complete and check the file. To turn this on, add a first line that points at the schema:

```yaml
# yaml-language-server: $schema=../path/to/bots.schema.json
version: 1
```

JSON Schema can't express one rule, that bot names must be unique within `bots.yaml`. Only the server checks it.

## Fields

The tables below and the JSON Schema files are generated from `apps/server/src/config/areas.ts`. A test fails when they're out of date. To regenerate them, run:

```sh
bun --bun vitest run -u apps/server/src/config
```

<!-- Generated from apps/server/src/config/areas.ts. Regenerate: bun --bun vitest run -u apps/server/src/config -->

### `bots.yaml`, version 1

What each bot is allowed to do. Instructions live in the bot's folder, not here (decision 0010).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `version` | `1` | yes | The file's format version. Aphelion migrates older ones. |
| `bots` | list of objects | yes | One entry per bot. Names must be unique. |
| `bots[].name` | string | yes | Unique bot name. Also the name of the bot's folder (decision 0010). |
| `bots[].provider` | string | yes | The bot CLI that runs the bot. |
| `bots[].model` | string | yes | The model the provider runs. |
| `bots[].connectors` | list of strings | yes | Ids of the connectors the bot may use. Can be empty. |
| `bots[].policyProfile` | string | yes | The approval profile the bot's actions pass. |
| `bots[].folder` | string | yes | Absolute path of the bot's folder. Normally the bot's name under /var/lib/aphelion-bots. |

### `policy.yaml`, version 1

Approval rules. No fields yet: M2-01 adds the policy model.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `version` | `1` | yes | The file's format version. Aphelion migrates older ones. |

### `routines.yaml`, version 1

Scheduled and on-demand routines. No fields yet: M6-02 adds routine definitions.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `version` | `1` | yes | The file's format version. Aphelion migrates older ones. |

### `connectors.yaml`, version 1

Connector settings. No fields yet: M3 adds connector entries.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `version` | `1` | yes | The file's format version. Aphelion migrates older ones. |

### `server.yaml`, version 1

Where the server listens for HTTP and WebSocket connections (decisions 0016 and 0022).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `version` | `1` | yes | The file's format version. Aphelion migrates older ones. |
| `address` | string | yes | The address the server listens on. In the container it must be 0.0.0.0, the container's own interface, and `aphelion config check --compose` refuses any other. The Compose file decides which host address the port is published on. |
| `port` | integer | yes | The TCP port the server listens on. In the container it must be 7400, the only port the host firewall lets in, and `aphelion config check --compose` refuses any other. |

<!-- End of generated section -->
