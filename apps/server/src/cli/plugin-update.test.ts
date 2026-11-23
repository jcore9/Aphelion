import { readFile, mkdir, mkdtemp, rm, readdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer } from "effect";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readTar, writeEntries } from "../plugins/updates/tar";
import { cli, CliFailure, CliIo } from "./index";

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

async function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io = Layer.succeed(CliIo, {
    out: (line) => Effect.sync(() => void out.push(line)),
    err: (line) => Effect.sync(() => void err.push(line)),
    stdin: Effect.succeed(""),
  });
  const exit = await Effect.runPromiseExit(cli(argv).pipe(Effect.provide(io)));
  let code = 0;
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause);
    code = error instanceof CliFailure ? error.exitCode : -1;
  }
  return { code, out, err };
}

const approval = (lines: string[]) =>
  /--approve ([0-9a-f]{64})$/.exec(lines.at(-1) ?? "")?.[1] ?? "";

async function installFolder() {
  const folder = join(pluginsDir, plugin);
  const unpacked = readTar(
    await readFile(join(fixtures, "v1.0.0", "aphelion-plugin.tar")),
  );
  if (!unpacked.ok) throw new Error(unpacked.reason);
  await mkdir(folder);
  await writeEntries(unpacked.entries, folder);
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
    out: [`${plugin} is already on 1.1.0, the latest release.`],
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
