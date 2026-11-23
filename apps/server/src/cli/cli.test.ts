import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer } from "effect";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readInstall } from "../plugins/approvals";
import { openStore } from "../store";
import { version } from "../version";
import { cli, CliFailure, CliIo } from "./index";
import { stdinLabel } from "./config-check";

const example = join(
  import.meta.dirname,
  "../../../../docs/reference/config/example",
);

let root: string;
let configDir: string;
let stateDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aphelion-cli-"));
  configDir = join(root, "etc");
  stateDir = join(root, "state");
  await cp(example, configDir, { recursive: true });
  await chmod(configDir, 0o750);
  for (const file of await readdir(configDir)) {
    await chmod(join(configDir, file), 0o640);
  }
  await mkdir(stateDir, { mode: 0o700 });
  await chmod(stateDir, 0o700);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function run(argv: string[], stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const io = Layer.succeed(CliIo, {
    out: (line) => Effect.sync(() => void out.push(line)),
    err: (line) => Effect.sync(() => void err.push(line)),
    stdin: Effect.succeed(stdin),
  });
  const exit = await Effect.runPromiseExit(cli(argv).pipe(Effect.provide(io)));
  let code = 0;
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause);
    code = error instanceof CliFailure ? error.exitCode : -1;
  }
  return { code, out, err };
}

const dirs = () => ["--config-dir", configDir, "--state-dir", stateDir];

test("--version prints the version", async () => {
  expect(await run(["--version"])).toEqual({
    code: 0,
    out: [`aphelion ${version}`],
    err: [],
  });
});

test("version.ts matches package.json", async () => {
  const pkg = JSON.parse(
    await readFile(join(import.meta.dirname, "../../package.json"), "utf8"),
  ) as { version: string };
  expect(version).toBe(pkg.version);
});

test("--help and no arguments print the commands", async () => {
  for (const argv of [["--help"], []]) {
    const { code, out } = await run(argv);
    expect(code).toBe(0);
    for (const command of [
      "aphelion --headless",
      "aphelion config check",
      "aphelion device add NAME",
      "aphelion device list",
      "aphelion device revoke ID",
      "aphelion --version",
    ]) {
      expect(out.join("\n")).toContain(command);
    }
  }
});

test("a usage error exits 2 and says how to get help", async () => {
  expect(await run(["device", "add"])).toEqual({
    code: 2,
    out: [],
    err: [
      'aphelion: "device add" needs a name',
      "Run aphelion --help to see the commands.",
    ],
  });
});

test("config check passes a good config", async () => {
  const { code, out } = await run(["config", "check", ...dirs()]);
  expect(code).toBe(0);
  expect(out).toEqual([
    "Config OK. The Compose file wasn't checked: pass --compose to check it.",
  ]);
});

test("config check lists folder mode problems first, and exits 1", async () => {
  await chmod(configDir, 0o755);
  await chmod(stateDir, 0o750);
  const { code, out, err } = await run(["config", "check", ...dirs()]);
  expect(code).toBe(1);
  expect(out).toEqual([
    `${configDir}: has mode 0755, which is looser than 0750`,
    `${stateDir}: has mode 0750, which is looser than 0700`,
  ]);
  expect(err).toEqual(["2 problems found."]);
});

test("config check reads the config files once the modes pass", async () => {
  await writeFile(
    join(configDir, "server.yaml"),
    "version: 1\naddress: x\nport: 7400\n",
  );
  const { code, out } = await run(["config", "check", ...dirs()]);
  expect(code).toBe(1);
  expect(out).toEqual([
    `${configDir}/server.yaml:2:10: address: must be an IPv4 or IPv6 address, such as 0.0.0.0`,
  ]);
});

test("config check --compose - refuses output with no services", async () => {
  const { code, out } = await run(
    ["config", "check", ...dirs(), "--compose", "-"],
    "{}",
  );
  expect(code).toBe(1);
  expect(out).toEqual([
    `${stdinLabel}: services: has no services, so this isn't the output of \`docker compose config\` for Aphelion's Compose file.`,
  ]);
});

test("config check reports a missing state folder", async () => {
  await rm(stateDir, { recursive: true });
  const { code, out } = await run(["config", "check", ...dirs()]);
  expect(code).toBe(1);
  expect(out).toEqual([`${stateDir}: is missing`]);
});

const tailnetCompose = `services:
  aphelion:
    ports:
      - host_ip: 100.71.226.67
        target: 7400
        published: "7400"
`;

test("config check --compose - accepts tailnet-only ports from standard input", async () => {
  const { code, out } = await run(
    ["config", "check", ...dirs(), "--compose", "-"],
    tailnetCompose,
  );
  expect(code).toBe(0);
  expect(out).toEqual([
    "Config OK. The Compose file publishes ports only on the tailnet, and server.yaml sets address 0.0.0.0 and port 7400.",
  ]);
});

test("config check --compose accepts the shipped config when the host port differs", async () => {
  const { code, out } = await run(
    ["config", "check", ...dirs(), "--compose", "-"],
    "services:\n  aphelion:\n    ports: ['100.71.226.67:8443:7400']\n",
  );
  expect(code).toBe(0);
  expect(out).toEqual([
    "Config OK. The Compose file publishes ports only on the tailnet, and server.yaml sets address 0.0.0.0 and port 7400.",
  ]);
});

test("config check --compose refuses a loopback address", async () => {
  await writeFile(
    join(configDir, "server.yaml"),
    "version: 1\naddress: 127.0.0.1\nport: 7400\n",
  );
  const { code, out, err } = await run(
    ["config", "check", ...dirs(), "--compose", "-"],
    tailnetCompose,
  );
  expect(code).toBe(1);
  expect(out).toEqual([
    `${configDir}/server.yaml: address: is 127.0.0.1. With --compose it must be 0.0.0.0, so a published port can reach the server inside the container.`,
  ]);
  expect(err).toEqual(["1 problem found."]);
});

test("config check --compose refuses a container port other than the server's", async () => {
  const { code, out } = await run(
    ["config", "check", ...dirs(), "--compose", "-"],
    "services:\n  aphelion:\n    ports: ['100.71.226.67:7400:7401']\n",
  );
  expect(code).toBe(1);
  expect(out).toEqual([
    `${stdinLabel}:3:13: services.aphelion.ports[0]: forwards to container port 7401, but it must forward to TCP port 7400, the server's port in server.yaml.`,
  ]);
});

test("config check --compose refuses a server port other than 7400 when the container port matches", async () => {
  await writeFile(
    join(configDir, "server.yaml"),
    "version: 1\naddress: 0.0.0.0\nport: 7401\n",
  );
  const { code, out } = await run(
    ["config", "check", ...dirs(), "--compose", "-"],
    "services:\n  aphelion:\n    ports: ['100.71.226.67:8443:7401']\n",
  );
  expect(code).toBe(1);
  expect(out).toEqual([
    `${configDir}/server.yaml: port: is 7401. With --compose it must be 7400, the port the host firewall opens.`,
  ]);
});

test("config check accepts a loopback address and a custom port without --compose", async () => {
  await writeFile(
    join(configDir, "server.yaml"),
    "version: 1\naddress: 127.0.0.1\nport: 7401\n",
  );
  const { code, out } = await run(["config", "check", ...dirs()]);
  expect(code).toBe(0);
  expect(out).toEqual([
    "Config OK. The Compose file wasn't checked: pass --compose to check it.",
  ]);
});

test("config check --compose still checks Compose ports when the config doesn't load", async () => {
  await writeFile(
    join(configDir, "server.yaml"),
    "version: 1\naddress: x\nport: 7400\n",
  );
  const { code, out } = await run(
    ["config", "check", ...dirs(), "--compose", "-"],
    "services:\n  aphelion:\n    ports: ['7400:7400']\n",
  );
  expect(code).toBe(1);
  expect(out).toEqual([
    `${configDir}/server.yaml:2:10: address: must be an IPv4 or IPv6 address, such as 0.0.0.0`,
    `${stdinLabel}:3:13: services.aphelion.ports[0]: publishes the port on every host address. Publish it only on the host's tailnet address, such as "100.71.226.67:7400:7400" (decision 0022).`,
  ]);
});

test("config check --compose - refuses a port on every address", async () => {
  const { code, out } = await run(
    ["config", "check", ...dirs(), "--compose", "-"],
    "services:\n  aphelion:\n    ports: ['7400:7400']\n",
  );
  expect(code).toBe(1);
  expect(out).toEqual([
    `${stdinLabel}:3:13: services.aphelion.ports[0]: publishes the port on every host address. Publish it only on the host's tailnet address, such as "100.71.226.67:7400:7400" (decision 0022).`,
  ]);
});

test("config check --compose - refuses empty input", async () => {
  const { code, out } = await run(
    ["config", "check", ...dirs(), "--compose", "-"],
    "",
  );
  expect(code).toBe(1);
  expect(out).toEqual([`${stdinLabel}: must be a YAML mapping`]);
});

test("config check --compose reads a file, and reports one it can't read", async () => {
  const file = join(root, "rendered.yaml");
  await writeFile(file, tailnetCompose);
  expect(
    (await run(["config", "check", ...dirs(), "--compose", file])).code,
  ).toBe(0);

  const missing = join(root, "missing.yaml");
  const { code, out } = await run([
    "config",
    "check",
    ...dirs(),
    "--compose",
    missing,
  ]);
  expect(code).toBe(1);
  expect(out).toEqual([`${missing}: can't be read (ENOENT)`]);
});

test("device add prints only the token on standard output, once", async () => {
  const { code, out, err } = await run([
    "device",
    "add",
    "my laptop",
    "--days",
    "30",
    "--state-dir",
    stateDir,
  ]);
  expect(code).toBe(0);
  expect(out).toHaveLength(1);
  const token = out[0] ?? "";
  expect(token).toMatch(/^aph_dev_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
  expect(err.join("\n")).not.toContain(token);
  expect(err[0]).toMatch(/^Added device "my laptop" with id [0-9a-f]{16}\./);

  const db = openStore(join(stateDir, "aphelion.db"));
  try {
    const [row] = db.all("SELECT name, created_at, expires_at FROM devices");
    expect(row?.["name"]).toBe("my laptop");
    const days =
      (Date.parse(String(row?.["expires_at"])) -
        Date.parse(String(row?.["created_at"]))) /
      86_400_000;
    expect(days).toBe(30);
    expect(JSON.stringify(db.all("SELECT * FROM audit_log"))).not.toContain(
      token,
    );
  } finally {
    db.close();
  }
});

test("device list shows each device's status, and revoke stops a token", async () => {
  const state = ["--state-dir", stateDir];
  expect((await run(["device", "list", ...state])).err).toEqual([
    "No devices. Add one with: aphelion device add <name>",
  ]);

  await run(["device", "add", "laptop", ...state]);
  await run(["device", "add", "phone", ...state]);
  const listed = await run(["device", "list", ...state]);
  expect(listed.out[0]).toBe("ID\tSTATUS\tEXPIRES\tNAME");
  const ids = listed.out.slice(1).map((line) => line.split("\t")[0] ?? "");
  expect(listed.out.slice(1).map((line) => line.split("\t")[1])).toEqual([
    "active",
    "active",
  ]);

  expect(await run(["device", "revoke", ids[0] ?? "", ...state])).toEqual({
    code: 0,
    out: [],
    err: [`Revoked device ${ids[0] ?? ""}.`],
  });
  const after = await run(["device", "list", ...state]);
  expect(after.out.slice(1).map((line) => line.split("\t")[1])).toEqual([
    "revoked",
    "active",
  ]);

  const again = await run(["device", "revoke", ids[0] ?? "", ...state]);
  expect(again.code).toBe(1);
  expect(again.err[0]).toContain("No active device has the id");
});

test("an unexpected error prints its message and exits 1", async () => {
  const { code, err } = await run([
    "device",
    "list",
    "--state-dir",
    join(root, "nowhere"),
  ]);
  expect(code).toBe(1);
  expect(err).toHaveLength(1);
  expect(err[0]).toMatch(/^aphelion: .*ENOENT/);
});

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

test("plugin install approves every file, and an upgrade needs a token that names the installed version", async () => {
  const folder = join(root, "plugin");
  await mkdir(folder);
  const file = join(folder, "aphelion-plugin.json");
  const manifest = {
    id: "weather",
    version: "1.0.0",
    api: "^0.2.0",
    server: { entry: "index.js" },
    permissions: { network: ["api.example.com"], events: ["bot.status"] },
  };
  const text = JSON.stringify(manifest);
  await writeFile(file, text);
  await writeFile(join(folder, "index.js"), "one");
  const files = (manifestText: string) =>
    sha256(
      JSON.stringify([
        ["aphelion-plugin.json", sha256(manifestText)],
        ["index.js", sha256("one")],
      ]),
    );
  const permissions = [
    ["events", "bot.status"],
    ["network", "api.example.com"],
  ];
  const token = (from: string | null, version: string, manifestText: string) =>
    sha256(
      JSON.stringify([
        "aphelion-approval-v1",
        "weather",
        from,
        version,
        folder,
        permissions,
        files(manifestText),
      ]),
    );
  const approval = token(null, "1.0.0", text);
  const command = ["plugin", "install", folder, "--state-dir", stateDir];

  const preview = await run(command);
  expect(preview.code).toBe(0);
  expect(preview.out).toEqual([
    `Plugin weather 1.0.0 at ${JSON.stringify(folder)}`,
    'events\t"bot.status"',
    'network\t"api.example.com"',
    expect.stringContaining(approval),
  ]);
  expect(await readdir(stateDir)).toEqual([]);

  const sibling = join(root, "sibling");
  await cp(folder, sibling, { recursive: true });
  expect(
    (
      await run([
        "plugin",
        "install",
        sibling,
        "--state-dir",
        stateDir,
        "--approve",
        approval,
      ])
    ).code,
  ).toBe(1);
  await writeFile(join(folder, "index.js"), "onf");
  expect((await run([...command, "--approve", approval])).code).toBe(1);
  expect(await readdir(stateDir)).toEqual([]);

  await writeFile(join(folder, "index.js"), "one");
  expect((await run([...command, "--approve", approval])).code).toBe(0);
  const installed = () => {
    const db = openStore(join(stateDir, "aphelion.db"));
    try {
      return readInstall(db, "weather");
    } finally {
      db.close();
    }
  };
  const first = {
    plugin: "weather",
    version: "1.0.0",
    source: "folder",
    folder,
    filesDigest: files(text),
    repository: undefined,
    grants: [
      { kind: "events", name: "bot.status" },
      { kind: "network", name: "api.example.com" },
    ],
  };
  expect(installed()).toEqual({
    plugin: "weather",
    current: first,
    previous: undefined,
  });

  const upgraded = JSON.stringify({ ...manifest, version: "1.1.0" });
  await writeFile(file, upgraded);
  const upgrade = await run(command);
  expect(upgrade.out[1]).toBe("Replaces the approved version 1.0.0");
  expect(
    (await run([...command, "--approve", token(null, "1.1.0", upgraded)])).code,
  ).toBe(1);
  const next = token("1.0.0", "1.1.0", upgraded);
  expect(upgrade.out.at(-1)).toContain(next);
  expect((await run([...command, "--approve", next])).code).toBe(0);
  expect(installed()).toEqual({
    plugin: "weather",
    current: { ...first, version: "1.1.0", filesDigest: files(upgraded) },
    previous: first,
  });
});
