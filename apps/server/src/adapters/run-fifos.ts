import { closeSync, constants, openSync } from "node:fs";
import { fdReadable, fdWriter } from "./fd-pipe";

export interface RunFifoPaths {
  readonly stdin: string;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunPipes {
  readonly write: (text: string) => Promise<void>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly close: () => void;
}

const reader = (path: string) =>
  openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);

async function writer(path: string, until: number): Promise<number> {
  for (;;) {
    try {
      return openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENXIO" || Date.now() >= until) throw error;
      await Bun.sleep(10);
    }
  }
}

const closeQuietly = (fd: number) => {
  try {
    closeSync(fd);
  } catch {
    return;
  }
};

export async function connectRun(
  paths: RunFifoPaths,
  deadlineMs: number,
  onWriteError: (error: Error) => void,
): Promise<RunPipes> {
  const opened: number[] = [];
  try {
    const stdout = reader(paths.stdout);
    opened.push(stdout);
    const stderr = reader(paths.stderr);
    opened.push(stderr);
    const stdin = await writer(paths.stdin, Date.now() + deadlineMs);
    opened.push(stdin);
    const sink = fdWriter(stdin, onWriteError);
    let closed = false;
    return {
      write: sink.write,
      stdout: fdReadable(stdout),
      stderr: fdReadable(stderr),
      close: () => {
        if (closed) return;
        closed = true;
        void sink.end();
        closeQuietly(stdout);
        closeQuietly(stderr);
      },
    };
  } catch (error) {
    for (const fd of opened) closeQuietly(fd);
    throw error;
  }
}
