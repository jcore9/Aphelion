import { spawnSync } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fdReadable, fdWriter } from "./fd-pipe";

const folders: string[] = [];
const opened: number[] = [];

afterEach(async () => {
  for (const fd of opened.splice(0)) {
    try {
      closeSync(fd);
    } catch {
      continue;
    }
  }
  for (const folder of folders.splice(0)) {
    await rm(folder, { recursive: true, force: true });
  }
});

const fifo = (folder: string, name: string) => {
  const path = join(folder, name);
  spawnSync("mkfifo", ["-m", "0600", path]);
  const hold = openSync(path, "r+");
  const reader = openSync(path, "r");
  const writer = openSync(path, "w");
  closeSync(hold);
  opened.push(reader, writer);
  return { reader, writer };
};

const within = <A>(promise: Promise<A>, ms: number) =>
  Promise.race([
    promise,
    new Promise<"stalled">((done) => {
      setTimeout(() => {
        done("stalled");
      }, ms);
    }),
  ]);

const collect = async (stream: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk);
  return text;
};

describe.skipIf(process.platform !== "linux")("the server's pipe ends", () => {
  it("keeps writing and reading files while many pipes wait for input", async () => {
    const folder = await mkdtemp(join(tmpdir(), "aphelion-fd-pipe-"));
    folders.push(folder);
    const idle = Array.from({ length: 16 }, (_, index) =>
      fifo(folder, `idle-${String(index)}`),
    );
    for (const { reader } of idle) void collect(fdReadable(reader));
    const out = fifo(folder, "out");
    const writer = fdWriter(out.writer, () => undefined);
    const work = async () => {
      await writer.write("still moving\n");
      return readFile("/proc/self/stat", "utf8");
    };
    expect(await within(work(), 2_000)).not.toBe("stalled");
  });

  it("delivers what the other end writes, and ends when it closes", async () => {
    const folder = await mkdtemp(join(tmpdir(), "aphelion-fd-pipe-"));
    folders.push(folder);
    const pipe = fifo(folder, "data");
    const read = collect(fdReadable(pipe.reader));
    writeSync(pipe.writer, "one\ntwo\n");
    closeSync(pipe.writer);
    opened.splice(opened.indexOf(pipe.writer), 1);
    expect(await within(read, 2_000)).toBe("one\ntwo\n");
  });

  it("writes lines that the other end reads", async () => {
    const folder = await mkdtemp(join(tmpdir(), "aphelion-fd-pipe-"));
    folders.push(folder);
    const pipe = fifo(folder, "out");
    const errors: Error[] = [];
    const writer = fdWriter(pipe.writer, (error) => errors.push(error));
    const read = collect(fdReadable(pipe.reader));
    await writer.write("hello\n");
    await writer.end();
    opened.splice(opened.indexOf(pipe.writer), 1);
    expect(await within(read, 2_000)).toBe("hello\n");
    expect(errors).toEqual([]);
  });
});
