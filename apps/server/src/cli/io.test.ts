import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { keyInputLimit, readKeyBytes } from "./io";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const terminal = () => {
  const modes: boolean[] = [];
  const stream = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (mode: boolean) => {
      modes.push(mode);
    },
  });
  return { stream, modes };
};

describe("readKeyBytes from a pipe", () => {
  it("reads everything up to the end, without a prompt", async () => {
    const stream = new PassThrough();
    const prompts: string[] = [];
    stream.end("sk-fake\nsecond line");
    const bytes = await readKeyBytes(stream, "API key: ", (line) => {
      prompts.push(line);
    });
    expect(text(bytes)).toBe("sk-fake\nsecond line");
    expect(prompts).toEqual([]);
  });

  it("stops after the limit, so a long input can't fill memory", async () => {
    const stream = new PassThrough();
    stream.end("k".repeat(keyInputLimit * 4));
    const bytes = await readKeyBytes(stream, "API key: ", () => undefined);
    expect(bytes.length).toBe(keyInputLimit);
  });
});

describe("readKeyBytes from a terminal", () => {
  it("turns echo off, reads one line with backspace, and turns echo back on", async () => {
    const { stream, modes } = terminal();
    const prompts: string[] = [];
    const reading = readKeyBytes(stream, "API key: ", (line) => {
      prompts.push(line);
    });
    stream.write("sk-fakx\u007fe-é\u007fe\rleft over");
    expect(text(await reading)).toBe("sk-fake-e");
    expect(modes).toEqual([true, false]);
    expect(prompts).toEqual(["API key: ", "\n"]);
  });

  it("stops on Ctrl-C and turns echo back on", async () => {
    const { stream, modes } = terminal();
    const reading = readKeyBytes(stream, "API key: ", () => undefined);
    stream.write("sk-fake\u0003");
    await expect(reading).rejects.toThrow("Stopped. No API key was read.");
    expect(modes).toEqual([true, false]);
  });

  it("ends the line on Ctrl-D", async () => {
    const { stream } = terminal();
    const reading = readKeyBytes(stream, "API key: ", () => undefined);
    stream.write("sk-fake\u0004");
    expect(text(await reading)).toBe("sk-fake");
  });
});
