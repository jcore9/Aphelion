import { join } from "node:path";
import { Cause, Effect, Exit, Layer } from "effect";
import { expect, test } from "vitest";
import type { Fetcher } from "../tools/vendor-latest";
import { CliFailure, CliIo } from "./index";
import { toolCheck } from "./tool";

const shippedList = join(
  import.meta.dirname,
  "../../../../deploy/ai-tools.json",
);

const claudeLatest = "https://downloads.claude.ai/claude-code-releases/latest";
const grokStable = "https://x.ai/cli/stable";
const codexLatest = "https://api.github.com/repos/openai/codex/releases/latest";
const opencodeReleases =
  "https://api.github.com/repos/anomalyco/opencode/releases?per_page=10";

const release = (tag: string) =>
  JSON.stringify({ tag_name: tag, draft: false, prerelease: false });

const vendors = (overrides: Record<string, Response | Error> = {}) => {
  const answers: Record<string, Response | Error> = {
    [claudeLatest]: new Response("2.1.330\n"),
    [grokStable]: new Response("1.0.92\n"),
    [codexLatest]: new Response(release("rust-v0.172.0")),
    [opencodeReleases]: new Response(`[${release("v2.4.1")}]`),
    ...overrides,
  };
  const asked: string[] = [];
  const fetcher = ((input: string | URL) => {
    const url = String(input);
    asked.push(url);
    const answer = answers[url];
    if (answer === undefined) {
      return Promise.resolve(new Response("", { status: 404 }));
    }
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer.clone());
  }) as Fetcher;
  return { fetcher, asked };
};

async function check(fetcher: Fetcher, listFile = shippedList) {
  const out: string[] = [];
  const err: string[] = [];
  const io = Layer.succeed(CliIo, {
    out: (line) => Effect.sync(() => void out.push(line)),
    err: (line) => Effect.sync(() => void err.push(line)),
    stdin: Effect.succeed(""),
    readApiKey: () => Effect.die("unused"),
  });
  const exit = await Effect.runPromiseExit(
    toolCheck(listFile, fetcher).pipe(Effect.provide(io)),
  );
  let code = 0;
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause);
    code = error instanceof CliFailure ? error.exitCode : -1;
  }
  return { code, out, err };
}

const header = "NAME\tPINNED\tLATEST\tSTATE";

test("tool check says current for every tool when each vendor's newest is the pinned version", async () => {
  expect(await check(vendors().fetcher)).toEqual({
    code: 0,
    out: [
      header,
      "claude\t2.1.330\t2.1.330\tcurrent",
      "codex\t0.172.0\t0.172.0\tcurrent",
      "grok\t1.0.92\t1.0.92\tcurrent",
      "opencode\t2.4.1\t2.4.1\tcurrent",
    ],
    err: [],
  });
});

test("tool check names the newer versions and ends with what to do, and still exits 0", async () => {
  const result = await check(
    vendors({
      [claudeLatest]: new Response("2.1.332\n"),
      [opencodeReleases]: new Response(
        `[${release("v2.4.2")},${release("v2.4.1")}]`,
      ),
    }).fetcher,
  );
  expect(result.code).toBe(0);
  expect(result.out.slice(0, 5)).toEqual([
    header,
    "claude\t2.1.330\t2.1.332\tnewer version available",
    "codex\t0.172.0\t0.172.0\tcurrent",
    "grok\t1.0.92\t1.0.92\tcurrent",
    "opencode\t2.4.1\t2.4.2\tnewer version available",
  ]);
  expect(result.out).toHaveLength(6);
  expect(result.out[5]).toContain("needs a new entry in the AI tool list");
  expect(result.out[5]).toContain("you approve");
  expect(result.out[5]).toContain("Update an AI tool");
});

test("tool check reports a vendor it can't read as unknown and keeps going", async () => {
  const result = await check(
    vendors({ [grokStable]: new Error("connection reset") }).fetcher,
  );
  expect(result.code).toBe(0);
  expect(result.out).toContain("grok\t1.0.92\t-\tunknown");
  expect(result.out).toContain("claude\t2.1.330\t2.1.330\tcurrent");
  expect(result.err).toEqual([
    expect.stringMatching(/^grok: .*connection reset/),
  ]);
});

test("tool check exits 1 when every vendor lookup failed", async () => {
  const result = await check(
    vendors({
      [claudeLatest]: new Error("offline"),
      [grokStable]: new Error("offline"),
      [codexLatest]: new Error("offline"),
      [opencodeReleases]: new Error("offline"),
    }).fetcher,
  );
  expect(result.code).toBe(1);
  expect(result.out.slice(1).every((row) => row.endsWith("\t-\tunknown"))).toBe(
    true,
  );
  expect(result.err).toHaveLength(4);
});

test("tool check asks only for version files and release lists", async () => {
  const { fetcher, asked } = vendors();
  await check(fetcher);
  expect(asked.sort()).toEqual(
    [claudeLatest, grokStable, codexLatest, opencodeReleases].sort(),
  );
});

test("tool check refuses a list it can't read", async () => {
  const result = await check(
    vendors().fetcher,
    join(import.meta.dirname, "no-such-list.json"),
  );
  expect(result.code).toBe(1);
  expect(result.err[0]).toContain("can't read the tool list");
});
