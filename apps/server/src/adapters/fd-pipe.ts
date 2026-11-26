import { closeSync } from "node:fs";

export const fdReadable = (fd: number): ReadableStream<Uint8Array> =>
  Bun.file(fd).stream();

export interface FdWriter {
  readonly write: (text: string) => Promise<void>;
  readonly end: () => Promise<void>;
}

const asError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

export function fdWriter(
  fd: number,
  onError: (error: Error) => void,
): FdWriter {
  const sink = Bun.file(fd).writer();
  return {
    write: async (text) => {
      try {
        await sink.write(text);
        await sink.flush();
      } catch (error) {
        onError(asError(error));
      }
    },
    end: async () => {
      try {
        await sink.end();
        closeSync(fd);
      } catch (error) {
        onError(asError(error));
      }
    },
  };
}
