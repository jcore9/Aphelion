import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { describe } from "vitest";
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

const host = (root: string) =>
  bunCgroupHost({
    mount: join(root, "mount"),
    tree: "bots",
    runs: join(root, "runs"),
    entry: "/bin/true",
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
          yield* cgroups.spawn(probe, entry, probeBot);
          const bot = yield* cgroups.makeRun(botRun);
          yield* cgroups.spawn(bot, entry, "alpha");
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
