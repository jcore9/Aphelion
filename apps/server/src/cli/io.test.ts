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

  it("passes on an error from the stream", async () => {
    const stream = new PassThrough();
    const reading = readKeyBytes(stream, "API key: ", () => undefined);
    stream.write("sk-fake");
    stream.destroy(new Error("the pipe broke"));
    await expect(reading).rejects.toThrow("the pipe broke");
  });

  it("stops when the signal aborts", async () => {
    const stream = new PassThrough();
    const stop = new AbortController();
    const reading = readKeyBytes(
      stream,
      "API key: ",
      () => undefined,
      stop.signal,
    );
    stream.write("sk-fake");
    stop.abort();
    await expect(reading).rejects.toThrow();
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

  it("turns echo back on when the stream fails", async () => {
    const { stream, modes } = terminal();
    const prompts: string[] = [];
    const reading = readKeyBytes(stream, "API key: ", (line) => {
      prompts.push(line);
    });
    stream.write("sk-fake");
    stream.destroy(new Error("the terminal went away"));
    await expect(reading).rejects.toThrow("the terminal went away");
    expect(modes).toEqual([true, false]);
    expect(prompts).toEqual(["API key: ", "\n"]);
  });

  it("stops and turns echo back on when the signal aborts", async () => {
    const { stream, modes } = terminal();
    const stop = new AbortController();
    const reading = readKeyBytes(
      stream,
      "API key: ",
      () => undefined,
      stop.signal,
    );
    stream.write("sk-fake");
    await new Promise((resolve) => setImmediate(resolve));
    stop.abort();
    await expect(reading).rejects.toThrow("Stopped. No API key was read.");
    expect(modes).toEqual([true, false]);
    expect(stream.listenerCount("data")).toBe(0);
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("stops when the stream ends", async () => {
    const { stream, modes } = terminal();
    const reading = readKeyBytes(stream, "API key: ", () => undefined);
    stream.end("sk-fake");
    expect(text(await reading)).toBe("sk-fake");
    expect(modes).toEqual([true, false]);
  });
});
