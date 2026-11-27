import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { describe } from "vitest";
import { newFolderVariable } from "../cgroups/protocol";
import { CgroupHost, probeBot } from "../cgroups/supervisor";
import { createLogger } from "../log";
import { bunCgroupHost, maxProbeAnswerBytes, probeAnswer } from "./cgroup-host";

const scratch = Effect.acquireRelease(
  Effect.sync(() => {
    const root = mkdtempSync(join(tmpdir(), "aphelion-host-"));
    mkdirSync(join(root, "mount", "bots", "work"), { recursive: true });
    mkdirSync(join(root, "runs"));
    return root;
  }),
  (root) =>
    Effect.sync(() => {
      rmSync(root, { recursive: true, force: true });
    }),
);

const host = (root: string, entry = "/bin/true") =>
  bunCgroupHost({
    mount: join(root, "mount"),
    tree: "bots",
    runs: join(root, "runs"),
    entry,
    bun: "/usr/local/bin/bun",
    botUid: 10002,
    logger: createLogger({ write: () => undefined }),
  });

const modes = (paths: {
  readonly folder: string;
  readonly stdin: string;
  readonly stdout: string;
  readonly stderr: string;
}) =>
  [paths.folder, paths.stdin, paths.stdout, paths.stderr].map((path) => {
    const info = statSync(path);
    return { mode: (info.mode & 0o777).toString(8), gid: info.gid };
  });

const entry = { bundle: "/adapters/fake.js", env: {} };
const probeRun = "0197a3c2-5f1e-7a2b-8c3d-4e5f60718293";
const botRun = "0197a3c2-5f1e-7a2b-9c3d-4e5f60718294";

const stream = (...chunks: string[]) =>
  new Blob(chunks).stream() as ReadableStream<Uint8Array>;

describe("the supervisor's cgroup host", () => {
  it.live(
    "keeps the probe's run folder and pipes to the supervisor alone, and opens a real bot's to the runs group",
    () =>
      Effect.gen(function* () {
        const root = yield* scratch;
        const group = statSync(join(root, "runs")).gid;
        const own = process.getgid?.() ?? 0;
        yield* Effect.gen(function* () {
          const cgroups = yield* CgroupHost;
          const probe = yield* cgroups.makeRun(probeRun);
          const created = modes(probe);
          yield* cgroups.spawn(
            probe,
            entry,
            probeBot,
            `/tmp/aphelion-probe-${probeRun}`,
            "probe",
          );
          const bot = yield* cgroups.makeRun(botRun);
          yield* cgroups.spawn(bot, entry, "alpha", "/srv/alpha", "bot");
          expect(created).toEqual([
            { mode: "700", gid: own },
            { mode: "600", gid: own },
            { mode: "600", gid: own },
            { mode: "600", gid: own },
          ]);
          expect(modes(probe)).toEqual(created);
          expect(modes(bot)).toEqual([
            { mode: "750", gid: group },
            { mode: "660", gid: group },
            { mode: "660", gid: group },
            { mode: "660", gid: group },
          ]);
        }).pipe(Effect.provide(host(root)));
      }).pipe(Effect.scoped),
  );

  it.live(
    "keeps a run folder private by the spawn's kind, not by the bot id, and asks only the probe's launcher for a new folder",
    () =>
      Effect.gen(function* () {
        const root = yield* scratch;
        const own = process.getgid?.() ?? 0;
        const script = join(root, "entry");
        writeFileSync(script, '#!/bin/sh\nenv > "$2/env-seen"\n', {
          mode: 0o755,
        });
        yield* Effect.gen(function* () {
          const cgroups = yield* CgroupHost;
          const probe = yield* cgroups.makeRun(probeRun);
          const probeChild = yield* cgroups.spawn(
            probe,
            entry,
            "alpha",
            `/tmp/aphelion-probe-${probeRun}`,
            "probe",
          );
          const bot = yield* cgroups.makeRun(botRun);
          const botChild = yield* cgroups.spawn(
            bot,
            entry,
            probeBot,
            "/srv/alpha",
            "bot",
          );
          yield* probeChild.exited;
          yield* botChild.exited;
          expect(modes(probe)[0]).toEqual({ mode: "700", gid: own });
          expect(modes(bot)[0]?.mode).toBe("750");
          const seen = (folder: string) =>
            readFileSync(join(folder, "env-seen"), "utf8").split("\n");
          expect(seen(probe.folder)).toContain(`${newFolderVariable}=1`);
          expect(
            seen(bot.folder).filter((line) =>
              line.startsWith(`${newFolderVariable}=`),
            ),
          ).toEqual([]);
        }).pipe(Effect.provide(host(root, script)));
      }).pipe(Effect.scoped),
  );

  it("reads the probe's answer from its first line", async () => {
    await expect(
      probeAnswer(stream('{"allowed":[]}\n', "ignored")),
    ).resolves.toEqual([]);
    await expect(
      probeAnswer(stream('{"allowed":["write /bots: ', 'ok"]}\n')),
    ).resolves.toEqual(["write /bots: ok"]);
  });

  it("refuses an answer that isn't the probe's shape, has too many entries or is too long", async () => {
    const tooMany = JSON.stringify({
      allowed: Array.from({ length: 65 }, (_, index) => String(index)),
    });
    const bad = [
      "not json\n",
      '{"allowed":"none"}\n',
      '{"allowed":[1]}\n',
      '{"allowed":[],"extra":true}\n',
      `${tooMany}\n`,
      '{"allowed":[]}',
      "",
    ];
    for (const text of bad) {
      await expect(probeAnswer(stream(text))).rejects.toThrow();
    }
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 4096;
        controller.enqueue(new Uint8Array(4096).fill(0x20));
      },
    });
    await expect(probeAnswer(endless)).rejects.toThrow();
    expect(pulled).toBeLessThan(2 * maxProbeAnswerBytes);
  });
});
