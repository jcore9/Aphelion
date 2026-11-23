import { maxPluginLineBytes } from "./wire.ts";

const newline = 0x0a;

export async function* readLines(
  chunks: AsyncIterable<Uint8Array>,
  onTooLong: () => void,
  maxBytes = maxPluginLineBytes,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let parts: Uint8Array[] = [];
  let size = 0;
  let skipping = false;

  const take = (bytes: Uint8Array) => {
    if (skipping || bytes.length === 0) return;
    if (size + bytes.length > maxBytes) {
      parts = [];
      size = 0;
      skipping = true;
      onTooLong();
      return;
    }
    parts.push(bytes.slice());
    size += bytes.length;
  };

  const finish = () => {
    const line = skipping || size === 0 ? undefined : join(parts, size);
    parts = [];
    size = 0;
    skipping = false;
    return line === undefined ? undefined : decoder.decode(line);
  };

  for await (const chunk of chunks) {
    let start = 0;
    for (let end = chunk.indexOf(newline); end !== -1;) {
      take(chunk.subarray(start, end));
      const line = finish();
      if (line !== undefined) yield line;
      start = end + 1;
      end = chunk.indexOf(newline, start);
    }
    take(chunk.subarray(start));
  }
  const last = finish();
  if (last !== undefined) yield last;
}

function join(parts: readonly Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
