# Config reference

The server reads its config from `/etc/aphelion/` ([decision 0014](../decisions/0014-filesystem-layout.md)). Code that runs in development passes another directory to `loadConfig`. Agents can't read or write this directory. They change agent entries only through the agent management tools ([decision 0010](../decisions/0010-agent-folders.md)).

## Layout

```
/etc/aphelion/          owner harness, mode 0750 or tighter
  agents.yaml           what each agent is allowed to do
  policy.yaml           approval rules (no fields yet, M2-01)
  routines.yaml         routines (no fields yet, M6-02)
  connectors.yaml       connector settings (no fields yet, M3)
```

All four files must exist. The directory can be a git repo. [`example/`](config/example/) holds a complete, valid directory, and a test loads it.

## File format

Each file is one YAML 1.2 document whose top level is a mapping. A key that appears twice in one mapping is an error. Unknown fields are errors too, so a misspelled field name never goes unnoticed.

Every file starts with a `version` field:

```yaml
version: 1
```

## Versions and migrations

Each file has its own version. When a file's format changes, its version goes up by one, and the server gains a migration that moves the old version forward. On load, the server runs the migrations from the file's version up to the current one, in memory, and then checks the result against the current schema. It doesn't rewrite the file. `loadConfig` returns the list of migrated files, so the caller can report them.

A file with a version newer than the server reads is an error. Upgrade Aphelion to read it.

Every file is at version 1, and no migrations exist yet.

## Owners and modes

`checkConfigPermissions` refuses a config directory that agents could read or write. `aphelion config check` calls it (M0-11).

| Path | Must be | Owner and group | Mode no looser than |
| --- | --- | --- | --- |
| `/etc/aphelion/` | a directory | the server's user and group | `0750` |
| Each of the four files | a regular file, not a symlink | the server's user and group | `0644` |

The files may be `0644`, the mode git checks files out with, because only the server's user and group can enter the directory. The check doesn't look inside a `.git` folder.

## Errors

Each error names the file, then the line and column where the parser found it, then the field. The line and column are left out when the file has no such position, for example when a field is missing from the top level.

```
/etc/aphelion/agents.yaml:5:12: agents[0].model: Invalid input: expected string, received number
```

| Cause | Example message |
| --- | --- |
| YAML syntax | `agents.yaml:4:1: Sequence item without - indicator` |
| A key twice in one mapping | `agents.yaml:2:1: Map keys must be unique` |
| Aliases that expand without limit | `agents.yaml: Excessive alias count indicates a resource exhaustion attack` |
| A missing file | ``agents.yaml: is missing. Create it with the line `version: 1`.`` |
| An empty file | `agents.yaml: must be a YAML mapping with a version field` |
| No `version` | `agents.yaml: version: is required` |
| A version newer than the server reads | `agents.yaml:1:10: version: must be a whole number from 1 to 1, the newest version this Aphelion reads` |
| A missing field | `agents.yaml:3:5: agents[0].model: is required` |
| An unknown field | `agents.yaml:9:12: agents[0].modle: unknown field` |
| A name that can't be a folder name | `agents.yaml:3:11: agents[0].name: must be 1 to 63 lowercase letters, digits or hyphens, starting with a letter` |
| A relative folder | `agents.yaml:8:13: agents[0].folder: must be an absolute path` |
| Two agents with one name | `agents.yaml:9:11: agents[1].name: duplicates agents[0].name "triage"` |
| A directory mode looser than 0750 | `/etc/aphelion: has mode 0755, which is looser than 0750` |
| A file that group or others can write | `/etc/aphelion/policy.yaml: has mode 0664, which is looser than 0644` |
| A config file that is a symlink | `/etc/aphelion/policy.yaml: must be a regular file, not a symlink` |
| The wrong owner | `/etc/aphelion: is owned by uid 4242, not the server's uid 1001` |

## JSON Schema for editors

Each file has a generated JSON Schema (draft-07) in [`config/`](config/): [`agents.schema.json`](config/agents.schema.json), [`policy.schema.json`](config/policy.schema.json), [`routines.schema.json`](config/routines.schema.json) and [`connectors.schema.json`](config/connectors.schema.json). The schemas describe the current version. To get completion and checks in an editor that runs the YAML language server, add a first line that points at the schema:

```yaml
# yaml-language-server: $schema=../path/to/agents.schema.json
version: 1
```

JSON Schema can't express one rule: agent names must be unique within `agents.yaml`. Only the server checks it.

## Fields

The tables below and the JSON Schema files are generated from `packages/server/src/config/areas.ts`. A test fails when they're out of date. To regenerate them, run:

```sh
bun --bun vitest run -u packages/server/src/config
```

<!-- Generated from packages/server/src/config/areas.ts. Regenerate: bun --bun vitest run -u packages/server/src/config -->

### `agents.yaml`, version 1

What each agent is allowed to do. Instructions live in the agent's folder, not here (decision 0010).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `version` | `1` | yes | The file's format version. Aphelion migrates older ones. |
| `agents` | list of objects | yes | One entry per agent. Names must be unique. |
| `agents[].name` | string | yes | Unique agent name. Also the name of the agent's folder (decision 0010). |
| `agents[].provider` | string | yes | The agent CLI that runs the agent. |
| `agents[].model` | string | yes | The model the provider runs. |
| `agents[].connectors` | list of strings | yes | Ids of the connectors the agent may use. Can be empty. |
| `agents[].policyProfile` | string | yes | The approval profile the agent's actions pass. |
| `agents[].folder` | string | yes | Absolute path of the agent's folder. Normally the agent's name under /var/lib/aphelion-agents. |

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

<!-- End of generated section -->
