import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  askForToken,
  interruptFromProcess,
  sleepUnlessAborted,
} from "./process-environment";

const tokenText = "aph_dev_0123456789abcdef_secret";

const prompt = () => {
  const input = new PassThrough();
  const shown: string[] = [];
  const answer = askForToken(input, (text) => shown.push(text));
  return { input, shown, answer };
};

describe("the token prompt", () => {
  test("returns the typed token without showing it", async () => {
    const { input, shown, answer } = prompt();

    input.write(`${tokenText}\n`);

    expect(await answer).toBe(tokenText);
    expect(shown.join("")).toBe("Device token: \n");
  });

  test("ends the line and gives nothing on Ctrl-D", async () => {
    const { input, shown, answer } = prompt();

    input.write("\u0004");

    expect(await answer).toBeNull();
    expect(shown.join("")).toBe("Device token: \n");
  });

  test("ends the line and gives nothing on Ctrl-C", async () => {
    const { input, shown, answer } = prompt();

    input.write("\u0003");

    expect(await answer).toBeNull();
    expect(shown.join("")).toBe("Device token: \n");
  });
});

describe("a process interrupt", () => {
  const runtimeHandler = vi.fn();

  afterEach(() => {
    process.off("SIGINT", runtimeHandler);
    runtimeHandler.mockReset();
  });

  test("goes to the chat and not to the runtime, which would exit 130", () => {
    process.on("SIGINT", runtimeHandler);
    const handler = vi.fn();

    const stop = interruptFromProcess(handler);
    process.emit("SIGINT");
    process.emit("SIGINT");

    expect(handler).toHaveBeenCalledTimes(2);
    expect(runtimeHandler).not.toHaveBeenCalled();

    stop();
    process.emit("SIGINT");

    expect(handler).toHaveBeenCalledTimes(2);
    expect(runtimeHandler).toHaveBeenCalledTimes(1);
  });
});

describe("the pause between connection attempts", () => {
  test("ends at once when it is aborted, and the timer doesn't stay", async () => {
    const abort = new AbortController();
    const started = Date.now();
    const paused = sleepUnlessAborted(60_000, abort.signal);

    abort.abort();
    await paused;

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("returns at once when it is already aborted", async () => {
    await sleepUnlessAborted(60_000, AbortSignal.abort());
  });

  test("waits for the time otherwise", async () => {
    const started = Date.now();

    await sleepUnlessAborted(30, new AbortController().signal);

    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});
