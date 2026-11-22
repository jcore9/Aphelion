import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { defineArea } from "./areas";
import { formatIssue } from "./issues";
import { loadConfig, parseArea, type LoadResult } from "./load";

const example = resolve(
  import.meta.dirname,
  "../../../../docs/reference/config/example",
);

const agent = [
  "  - name: triage",
  "    provider: grok",
  "    model: grok-4.7",
  "    connectors: []",
  "    policyProfile: default",
  "    folder: /var/lib/aphelion-agents/triage",
].join("\n");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aphelion-config-"));
  for (const file of ["policy.yaml", "routines.yaml", "connectors.yaml"]) {
    await writeFile(join(dir, file), "version: 1\n");
  }
  await writeFile(
    join(dir, "server.yaml"),
    "version: 1\naddress: 0.0.0.0\nport: 7400\n",
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function loadAgents(text: string): Promise<LoadResult> {
  await writeFile(join(dir, "agents.yaml"), text);
  return loadConfig(dir);
}

function messages(result: LoadResult): string[] {
  return result.ok ? [] : result.issues.map(formatIssue);
}

test("loads the example config from the docs into typed config", async () => {
  const result = await loadConfig(example);
  if (!result.ok) throw new Error(messages(result).join("\n"));
  expect(result.config.agents.agents.map((entry) => entry.name)).toEqual([
    "chief-of-staff",
    "triage",
  ]);
  expect(result.config.policy).toEqual({ version: 1 });
  expect(result.config.server).toEqual({
    version: 1,
    address: "0.0.0.0",
    port: 7400,
  });
  expect(result.migrated).toEqual([]);
});

describe("agents.yaml", () => {
  test("accepts a valid agent", async () => {
    const result = await loadAgents(`version: 1\nagents:\n${agent}\n`);
    expect(messages(result)).toEqual([]);
  });

  test("names the file, line, column and field of a missing field", async () => {
    const text = `version: 1\nagents:\n${agent.replace("    model: grok-4.7\n", "")}\n`;
    expect(messages(await loadAgents(text))).toEqual([
      `${join(dir, "agents.yaml")}:3:5: agents[0].model: is required`,
    ]);
  });

  test("rejects a field with the wrong type at its own line", async () => {
    const text = `version: 1\nagents:\n${agent.replace("model: grok-4.7", "model: 47")}\n`;
    expect(messages(await loadAgents(text))).toEqual([
      `${join(dir, "agents.yaml")}:5:12: agents[0].model: Invalid input: expected string, received number`,
    ]);
  });

  test("rejects an unknown field", async () => {
    const text = `version: 1\nagents:\n${agent}\n    modle: typo\n`;
    expect(messages(await loadAgents(text))).toEqual([
      `${join(dir, "agents.yaml")}:9:12: agents[0].modle: unknown field`,
    ]);
  });

  test("rejects names that can't be folder names", async () => {
    const text = `version: 1\nagents:\n${agent.replace("name: triage", "name: ../root")}\n`;
    expect(messages(await loadAgents(text))).toEqual([
      `${join(dir, "agents.yaml")}:3:11: agents[0].name: must be 1 to 63 lowercase letters, digits or hyphens, starting with a letter`,
    ]);
  });

  test("rejects a relative folder", async () => {
    const text = `version: 1\nagents:\n${agent.replace("folder: /var/lib/aphelion-agents/triage", "folder: triage")}\n`;
    expect(messages(await loadAgents(text))).toEqual([
      `${join(dir, "agents.yaml")}:8:13: agents[0].folder: must be an absolute path`,
    ]);
  });

  test("rejects a second agent with the same name", async () => {
    const text = `version: 1\nagents:\n${agent}\n${agent}\n`;
    expect(messages(await loadAgents(text))).toEqual([
      `${join(dir, "agents.yaml")}:9:11: agents[1].name: duplicates agents[0].name "triage"`,
    ]);
  });
});

describe("server.yaml", () => {
  async function loadServer(text: string): Promise<LoadResult> {
    await writeFile(join(dir, "server.yaml"), text);
    return loadAgents("version: 1\nagents: []\n");
  }

  test.each(["0.0.0.0", "127.0.0.1", "::", "100.71.226.67"])(
    "accepts the address %s",
    async (address) => {
      const result = await loadServer(
        `version: 1\naddress: "${address}"\nport: 7400\n`,
      );
      expect(messages(result)).toEqual([]);
    },
  );

  test("rejects an address that isn't an IP address", async () => {
    const result = await loadServer(
      "version: 1\naddress: localhost\nport: 7400\n",
    );
    expect(messages(result)).toEqual([
      `${join(dir, "server.yaml")}:2:10: address: must be an IPv4 or IPv6 address, such as 0.0.0.0`,
    ]);
  });

  test("rejects a port outside 1 to 65535", async () => {
    const result = await loadServer(
      "version: 1\naddress: 0.0.0.0\nport: 70000\n",
    );
    expect(messages(result)).toEqual([
      `${join(dir, "server.yaml")}:3:7: port: must be from 1 to 65535`,
    ]);
  });
});

describe("any config file", () => {
  test("reports a YAML syntax error with its position", async () => {
    const result = await loadAgents(
      "version: 1\nagents:\n  - name: a\n   model: b\n",
    );
    expect(messages(result)).toEqual([
      `${join(dir, "agents.yaml")}:4:1: Sequence item without - indicator`,
    ]);
  });

  test("rejects a key that appears twice", async () => {
    const result = await loadAgents("version: 1\nversion: 1\nagents: []\n");
    expect(messages(result)).toEqual([
      `${join(dir, "agents.yaml")}:2:1: Map keys must be unique`,
    ]);
  });

  test("refuses a file whose aliases expand without limit", async () => {
    const levels = "abcdefgh".split("");
    const bomb = [
      "version: 1",
      "a: &a [x, x, x, x, x, x, x, x, x]",
      ...levels.slice(1).map(
        (name, index) =>
          `${name}: &${name} [${Array(9)
            .fill(`*${levels[index] ?? ""}`)
            .join(", ")}]`,
      ),
    ].join("\n");
    expect(messages(await loadAgents(bomb))).toEqual([
      `${join(dir, "agents.yaml")}: Excessive alias count indicates a resource exhaustion attack`,
    ]);
  });

  test("rejects a version newer than this Aphelion reads", async () => {
    expect(messages(await loadAgents("version: 2\nagents: []\n"))).toEqual([
      `${join(dir, "agents.yaml")}:1:10: version: must be a whole number from 1 to 1, the newest version this Aphelion reads`,
    ]);
  });

  test("rejects a file without a version", async () => {
    expect(messages(await loadAgents("agents: []\n"))).toEqual([
      `${join(dir, "agents.yaml")}: version: is required`,
    ]);
  });

  test("rejects an empty file", async () => {
    expect(messages(await loadAgents(""))).toEqual([
      `${join(dir, "agents.yaml")}: must be a YAML mapping with a version field`,
    ]);
  });

  test("rejects fields in a file whose schema has none yet", async () => {
    await writeFile(join(dir, "policy.yaml"), "version: 1\nrules: []\n");
    expect(messages(await loadAgents("version: 1\nagents: []\n"))).toEqual([
      `${join(dir, "policy.yaml")}:2:8: rules: unknown field`,
    ]);
  });

  test("reports every missing file", async () => {
    await rm(join(dir, "policy.yaml"));
    expect(messages(await loadConfig(dir))).toEqual([
      `${join(dir, "agents.yaml")}: is missing. Create it with the line \`version: 1\`.`,
      `${join(dir, "policy.yaml")}: is missing. Create it with the line \`version: 1\`.`,
    ]);
  });
});

describe("migrations", () => {
  const notes = defineArea({
    file: "notes.yaml",
    description: "A test area at version 2.",
    migrations: [({ workspace, ...rest }) => ({ ...rest, folder: workspace })],
    fields: { folder: z.string() },
  });

  test("moves a version 1 file forward to the current version", () => {
    expect(
      parseArea(notes, "notes.yaml", "version: 1\nworkspace: /srv/notes\n"),
    ).toEqual({
      ok: true,
      value: { version: 2, folder: "/srv/notes" },
      migratedFrom: 1,
    });
  });

  test("leaves a current file as it is", () => {
    expect(
      parseArea(notes, "notes.yaml", "version: 2\nfolder: /srv/notes\n"),
    ).toEqual({
      ok: true,
      value: { version: 2, folder: "/srv/notes" },
      migratedFrom: undefined,
    });
  });

  test("validates the migrated result against the current schema", () => {
    const result = parseArea(notes, "notes.yaml", "version: 1\nworkspace: 7\n");
    expect(result.ok ? [] : result.issues.map(formatIssue)).toEqual([
      "notes.yaml: folder: Invalid input: expected string, received number",
    ]);
  });
});
