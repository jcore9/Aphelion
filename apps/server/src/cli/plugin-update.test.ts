import {
  readFile,
  mkdir,
  mkdtemp,
  rm,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, test } from "vitest";
import { lockFile } from "../adapters/file-lock";
import { createLogger } from "../log";
import {
  controlSocketFile,
  noServerPart,
  serveControlSocket,
  type ControlReply,
} from "../plugins/control";
import { filesLockFile } from "../plugins/updates/files-lock";
import { readTar, writeEntries } from "../plugins/updates/tar";
import { run } from "./testing";

const plugin = "aphelion-test-plugin";
const fixtures = join(
  import.meta.dirname,
  "../plugins/updates/fixtures",
  plugin,
);

let root: string;
let stateDir: string;
let pluginsDir: string;
let server: Server;
let latest: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aphelion-update-cli-"));
  stateDir = join(root, "state");
  pluginsDir = join(root, "plugins");
  await mkdir(stateDir, { mode: 0o700 });
  await mkdir(pluginsDir);
  latest = "v1.1.0";
  server = createServer((request, response) => {
    void (async () => {
      const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
      const path = request.url ?? "";
      if (path === `/repos/jcore9-bot/${plugin}/releases/latest`) {
        const json = await readFile(
          join(fixtures, latest, "release.json"),
          "utf8",
        );
        response.end(json.replaceAll("https://github.com", origin));
        return;
      }
      const asset =
        /^\/jcore9-bot\/[^/]+\/releases\/download\/([^/]+)\/([^/]+)$/.exec(
          path,
        );
      if (asset?.[1] && asset[2]) {
        response.end(await readFile(join(fixtures, asset[1], asset[2])));
        return;
      }
      response.statusCode = 404;
      response.end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env["APHELION_GITHUB_API"] =
    `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterEach(async () => {
  delete process.env["APHELION_GITHUB_API"];
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

const approval = (lines: string[]) =>
  /--approve ([0-9a-f]{64})$/.exec(lines.at(-1) ?? "")?.[1] ?? "";

async function unpackFixture(folder: string) {
  const unpacked = readTar(
    await readFile(join(fixtures, "v1.0.0", "aphelion-plugin.tar")),
  );
  if (!unpacked.ok) throw new Error(unpacked.reason);
  await mkdir(folder, { recursive: true });
  await writeEntries(unpacked.entries, folder);
}

async function installFolder() {
  const folder = join(pluginsDir, plugin);
  await unpackFixture(folder);
  const install = ["plugin", "install", folder, "--state-dir", stateDir];
  const preview = await run(install);
  expect(
    (await run([...install, "--approve", approval(preview.out)])).code,
  ).toBe(0);
  return folder;
}

const dirs = () => ["--state-dir", stateDir, "--plugins-dir", pluginsDir];

test("plugin update previews, installs on approval, and plugin rollback goes back", async () => {
  await installFolder();
  const update = ["plugin", "update", plugin, ...dirs()];

  const preview = await run(update);
  expect(preview).toEqual({
    code: 0,
    out: [
      `Plugin ${plugin} can update from 1.0.0 to 1.1.0.`,
      `GitHub attests that jcore9-bot/${plugin}'s release workflow built 1.1.0 from tag v1.1.0.`,
      'adds\tevents\t"bot.status"',
      expect.stringMatching(
        /^Review the changes above\. To install 1\.1\.0 and grant its permissions, repeat the command with --approve [0-9a-f]{64}$/,
      ),
    ],
    err: [],
  });
  expect((await readdir(pluginsDir)).sort()).toEqual([".staging", plugin]);

  expect(await run([...update, "--approve", "0".repeat(64)])).toEqual({
    code: 1,
    out: [],
    err: [
      "The approval doesn't match this release's files, permissions or the installed version. Preview the update again.",
    ],
  });

  expect(await run([...update, "--approve", approval(preview.out)])).toEqual({
    code: 0,
    out: [
      `Updated ${plugin} from 1.0.0 to 1.1.0.`,
      `The server isn't running, so ${plugin} starts on 1.1.0 when the server starts.`,
    ],
    err: [],
  });
  expect((await readdir(pluginsDir)).sort()).toEqual([
    ".staging",
    plugin,
    `${plugin}@1.1.0`,
  ]);

  expect(await run(update)).toEqual({
    code: 0,
    out: [
      `${plugin} is already on 1.1.0, the latest release. If the server still runs an older version, run aphelion plugin restart ${plugin}.`,
    ],
    err: [],
  });

  const back = ["plugin", "rollback", plugin, ...dirs()];
  expect(await run(back)).toEqual({
    code: 0,
    out: [
      `Went back from ${plugin} 1.1.0 to 1.0.0.`,
      `The server isn't running, so ${plugin} starts on 1.0.0 when the server starts.`,
    ],
    err: [],
  });
  expect((await readdir(pluginsDir)).sort()).toEqual([".staging", plugin]);
  expect(await run(back)).toEqual({
    code: 1,
    out: [],
    err: [`${plugin} has no earlier version to go back to.`],
  });
});

test("plugin update refuses when GitHub can't be reached, and when nothing is installed", async () => {
  expect(await run(["plugin", "update", plugin, ...dirs()])).toEqual({
    code: 1,
    out: [],
    err: [`${plugin} isn't installed.`],
  });
  await installFolder();
  const closed = process.env["APHELION_GITHUB_API"] ?? "";
  await new Promise((resolve) => server.close(resolve));
  const result = await run(["plugin", "update", plugin, ...dirs()]);
  expect(result.code).toBe(1);
  expect(result.err).toEqual([
    expect.stringMatching(new RegExp(`^Can't reach ${new URL(closed).host}: `)),
  ]);
});

test("plugin update takes --plugins-dir only as an absolute path", async () => {
  const result = await run([
    "plugin",
    "update",
    plugin,
    "--plugins-dir",
    "plugins",
  ]);
  expect(result.code).toBe(2);
  expect(result.err[0]).toBe(
    "aphelion: --plugins-dir must be an absolute path",
  );
});

test("a second plugin install, update or rollback waits its turn through the lock", async () => {
  const folder = await installFolder();
  const held = lockFile(join(stateDir, filesLockFile));
  expect(held.kind).toBe("locked");
  const busy = {
    code: 1,
    out: [],
    err: [
      "Another plugin or AI tool change is running. Try again when it finishes.",
    ],
  };
  expect(await run(["plugin", "update", plugin, ...dirs()])).toEqual(busy);
  expect(await run(["plugin", "rollback", plugin, ...dirs()])).toEqual(busy);
  const install = ["plugin", "install", folder, "--state-dir", stateDir];
  const preview = await run(install);
  const approve = [...install, "--approve", approval(preview.out)];
  expect((await run(approve)).err).toEqual(busy.err);
  if (held.kind === "locked") held.release();
  expect((await run(approve)).code).toBe(0);
  expect((await run(["plugin", "update", plugin, ...dirs()])).code).toBe(0);
});

test("an update approval stops working when the installed version is approved again", async () => {
  const folder = await installFolder();
  const update = ["plugin", "update", plugin, ...dirs()];
  const stale = approval((await run(update)).out);
  const manifestFile = join(folder, "aphelion-plugin.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as {
    permissions: { events: string[] };
  };
  manifest.permissions.events.push("bot.status");
  await writeFile(manifestFile, JSON.stringify(manifest));
  const install = ["plugin", "install", folder, "--state-dir", stateDir];
  const again = await run(install);
  expect((await run([...install, "--approve", approval(again.out)])).code).toBe(
    0,
  );

  expect(await run([...update, "--approve", stale])).toEqual({
    code: 1,
    out: [],
    err: [
      "The approval doesn't match this release's files, permissions or the installed version. Preview the update again.",
    ],
  });
  const fresh = await run(update);
  expect(fresh.out).toContain("No permission changes.");
  expect((await run([...update, "--approve", approval(fresh.out)])).code).toBe(
    0,
  );
});

const withServer = async (
  replies: ControlReply[],
  work: () => Promise<void>,
) => {
  const requests: unknown[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* serveControlSocket(
          join(stateDir, controlSocketFile),
          (line) =>
            Effect.sync(() => {
              requests.push(JSON.parse(line));
              return {
                reply: replies.shift() ?? { type: "refused", reason: "none" },
              };
            }),
          createLogger({ level: "error", write: () => undefined }),
        );
        yield* Effect.promise(work);
      }),
    ),
  );
  return requests;
};

test("plugin update reports both versions when it restores a running plugin", async () => {
  await installFolder();
  const update = ["plugin", "update", plugin, ...dirs()];
  const approve = [...update, "--approve", approval((await run(update)).out)];
  await withServer(
    [
      { type: "restarted", plugin, state: "crashed" },
      { type: "restarted", plugin, state: "running" },
    ],
    async () => {
      expect(await run(approve)).toEqual({
        code: 1,
        out: [],
        err: [
          `${plugin} 1.1.0 didn't start (it is crashed), so Aphelion went back to 1.0.0.`,
          `${plugin} 1.0.0 runs.`,
        ],
      });
    },
  );
});

test("plugin update reports a client-only version without a restart", async () => {
  await installFolder();
  const update = ["plugin", "update", plugin, ...dirs()];
  const approve = [...update, "--approve", approval((await run(update)).out)];
  await withServer(
    [{ type: "refused", reason: noServerPart(plugin) }],
    async () => {
      expect(await run(approve)).toEqual({
        code: 0,
        out: [
          `Updated ${plugin} from 1.0.0 to 1.1.0.`,
          `${plugin} has no server part to restart.`,
        ],
        err: [],
      });
    },
  );
});

test("a rollback whose version doesn't start stays on the version it left", async () => {
  await installFolder();
  const update = ["plugin", "update", plugin, ...dirs()];
  await run([...update, "--approve", approval((await run(update)).out)]);
  const back = ["plugin", "rollback", plugin, ...dirs()];
  const requests = await withServer(
    [
      { type: "restarted", plugin, state: "crashed" },
      { type: "restarted", plugin, state: "running" },
    ],
    async () => {
      expect(await run(back)).toEqual({
        code: 1,
        out: [],
        err: [
          `${plugin} 1.0.0 didn't start (it is crashed), so Aphelion stayed on 1.1.0.`,
          `${plugin} 1.1.0 runs.`,
        ],
      });
    },
  );
  expect(requests).toHaveLength(2);
  expect((await readdir(pluginsDir)).sort()).toEqual([
    ".staging",
    plugin,
    `${plugin}@1.1.0`,
  ]);
  expect((await run(back)).out).toEqual([
    `Went back from ${plugin} 1.1.0 to 1.0.0.`,
    `The server isn't running, so ${plugin} starts on 1.0.0 when the server starts.`,
  ]);
});

test("plugin install refuses a folder that plugin update manages", async () => {
  const link = join(root, "plugins-link");
  await symlink(pluginsDir, link);
  const install = (folder: string) =>
    run([
      "plugin",
      "install",
      folder,
      "--state-dir",
      stateDir,
      "--plugins-dir",
      link,
    ]);
  const release = join(pluginsDir, `${plugin}@1.0.0`);
  const staged = join(pluginsDir, ".staging", "release-x");
  for (const [folder, what] of [
    [release, "a release folder that plugin update manages"],
    [staged, "inside .staging, where plugin update unpacks"],
  ] as const) {
    await unpackFixture(folder);
    expect(await install(folder)).toEqual({
      code: 1,
      out: [],
      err: [
        `${folder} is ${what}, so it can't be installed as a folder. Copy it to another folder first.`,
      ],
    });
  }
  for (const name of [
    plugin,
    `${plugin}@notes`,
    `${plugin}@1.0.0-beta`,
    "Not-A-Plugin@1.0.0",
  ]) {
    const copy = join(pluginsDir, name);
    await unpackFixture(copy);
    expect((await install(copy)).code).toBe(0);
  }
});

test("plugin restart prints the server's answer", async () => {
  const restart = ["plugin", "restart", plugin, "--state-dir", stateDir];
  expect(await run(restart)).toEqual({
    code: 0,
    out: [
      `The server isn't running, so ${plugin} starts on its approved version when the server starts.`,
    ],
    err: [],
  });
  const results: Awaited<ReturnType<typeof run>>[] = [];
  const requests = await withServer(
    [
      { type: "restarted", plugin, state: "running" },
      { type: "restarted", plugin, state: "crashed" },
      { type: "refused", reason: `${plugin} stays stopped: it changed.` },
    ],
    async () => {
      for (let i = 0; i < 3; i++) results.push(await run(restart));
    },
  );
  expect(requests).toEqual(
    Array.from({ length: 3 }, () => ({ type: "restart", plugin })),
  );
  expect(results).toEqual([
    { code: 0, out: [`Restarted ${plugin}. It runs.`], err: [] },
    {
      code: 1,
      out: [],
      err: [
        `Restarted ${plugin}, but it isn't running: crashed. The server log says why.`,
      ],
    },
    {
      code: 1,
      out: [],
      err: [
        `The server didn't restart ${plugin}: ${plugin} stays stopped: it changed.`,
      ],
    },
  ]);
});

const switchedOff = `${plugin} is switched off. Switch it on first: aphelion plugin enable ${plugin}`;

test("after a restore, update, rollback and restart refuse a switched-off plugin", async () => {
  await installFolder();
  const finished = await run(["restore", "finish", "--state-dir", stateDir]);
  expect(finished.out).toContain(
    `Plugin ${plugin} is switched off. Switch it on: aphelion plugin enable ${plugin}`,
  );
  const refused = { code: 1, out: [], err: [switchedOff] };

  expect(await run(["plugin", "update", plugin, ...dirs()])).toEqual(refused);
  expect(
    await run([
      "plugin",
      "update",
      plugin,
      ...dirs(),
      "--approve",
      "0".repeat(64),
    ]),
  ).toEqual(refused);
  expect(await run(["plugin", "rollback", plugin, ...dirs()])).toEqual(refused);
  expect(
    await run(["plugin", "restart", plugin, "--state-dir", stateDir]),
  ).toEqual(refused);
});

test("plugin enable previews the recorded permissions, needs the matching digest, and is safe to repeat", async () => {
  await installFolder();
  await run(["restore", "finish", "--state-dir", stateDir]);
  const enable = ["plugin", "enable", plugin, "--state-dir", stateDir];

  const preview = await run(enable);
  expect(preview.code).toBe(0);
  expect(preview.out[0]).toContain(`Plugin ${plugin} 1.0.0`);
  expect(preview.out.at(-1)).toMatch(/--approve [0-9a-f]{64}$/);
  const token = approval(preview.out);

  const wrong = await run([...enable, "--approve", "0".repeat(64)]);
  expect(wrong.code).toBe(1);
  expect(wrong.err[0]).toContain("does not match");
  expect(
    (await run(["plugin", "restart", plugin, "--state-dir", stateDir])).code,
  ).toBe(1);

  expect(await run([...enable, "--approve", token])).toEqual({
    code: 0,
    out: [
      `Switched on ${plugin}. The server isn't running, so ${plugin} starts when the server starts.`,
    ],
    err: [],
  });
  const again = {
    code: 0,
    out: [`${plugin} is already switched on. Nothing changed.`],
    err: [],
  };
  expect(await run(enable)).toEqual(again);
  expect(await run([...enable, "--approve", token])).toEqual(again);
  expect(
    (await run(["plugin", "restart", plugin, "--state-dir", stateDir])).err,
  ).toEqual([]);
});

test("plugin enable restarts the plugin through the running server", async () => {
  await installFolder();
  await run(["restore", "finish", "--state-dir", stateDir]);
  const enable = ["plugin", "enable", plugin, "--state-dir", stateDir];
  const token = approval((await run(enable)).out);
  let result: Awaited<ReturnType<typeof run>> | undefined;

  const requests = await withServer(
    [{ type: "restarted", plugin, state: "running" }],
    async () => {
      result = await run([...enable, "--approve", token]);
    },
  );

  expect(requests).toEqual([{ type: "restart", plugin }]);
  expect(result).toEqual({
    code: 0,
    out: [`Switched on ${plugin}. It runs.`],
    err: [],
  });
});

test("plugin enable refuses files that changed since they were approved, and an unknown plugin", async () => {
  const folder = await installFolder();
  await run(["restore", "finish", "--state-dir", stateDir]);
  await writeFile(join(folder, "index.js"), "edited");

  const changed = await run([
    "plugin",
    "enable",
    plugin,
    "--state-dir",
    stateDir,
  ]);
  expect(changed).toEqual({
    code: 1,
    out: [],
    err: [
      `The files in ${folder} changed since they were approved. Review them and run: aphelion plugin install ${folder}`,
    ],
  });
  expect(
    await run(["plugin", "enable", "nothing", "--state-dir", stateDir]),
  ).toEqual({ code: 1, out: [], err: ["nothing isn't installed."] });
});
