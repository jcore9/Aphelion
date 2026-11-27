import { closeSync } from "node:fs";

export const fdReadable = (fd: number): ReadableStream<Uint8Array> =>
  Bun.file(fd).stream();

export interface FdReader {
  readonly stream: ReadableStream<Uint8Array>;
  readonly close: () => Promise<void>;
}

export function fdReader(fd: number): FdReader {
  const source: ReadableStream<Uint8Array> = Bun.file(fd).stream();
  let reader:
    | {
        readonly read: () => Promise<{
          readonly done: boolean;
          readonly value?: Uint8Array | undefined;
        }>;
        readonly cancel: () => Promise<void>;
      }
    | undefined;
  let closed = false;
  const isClosed = () => closed;
  const cancelSource = async () => {
    try {
      await (reader ?? source).cancel();
    } catch {
      return;
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start() {
      if (!isClosed()) reader = source.getReader();
    },
    async pull(controller) {
      if (isClosed() || reader === undefined) {
        await cancelSource();
        controller.close();
        return;
      }
      const chunk = await reader.read();
      if (isClosed() || chunk.done || chunk.value === undefined) {
        await cancelSource();
        controller.close();
        return;
      }
      controller.enqueue(chunk.value);
    },
    async cancel() {
      closed = true;
      await cancelSource();
    },
  });
  return {
    stream,
    close: async () => {
      if (closed) return;
      closed = true;
      await cancelSource();
    },
  };
}

export interface FdWriter {
  readonly write: (text: string) => Promise<void>;
  readonly end: () => Promise<void>;
  readonly close: () => void;
}

const asError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

export function fdWriter(
  fd: number,
  onError: (error: Error) => void,
): FdWriter {
  const sink = Bun.file(fd).writer();
  let closed = false;
  const isClosed = () => closed;
  const closeFd = () => {
    try {
      closeSync(fd);
    } catch {
      return;
    }
  };
  return {
    write: async (text) => {
      if (isClosed()) return;
      try {
        await sink.write(text);
        await sink.flush();
      } catch (error) {
        if (!isClosed()) onError(asError(error));
      }
    },
    end: async () => {
      if (closed) return;
      closed = true;
      try {
        await sink.end();
      } catch (error) {
        onError(asError(error));
      } finally {
        closeFd();
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      closeFd();
    },
  };
}
