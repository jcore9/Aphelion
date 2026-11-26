const utf8 = new TextEncoder();

const byteLength = (text: string) => utf8.encode(text).byteLength;

export function splitBytes(text: string, maxBytes: number): string[] {
  const pieces: string[] = [];
  let piece = "";
  let size = 0;
  for (const char of text) {
    const width = byteLength(char);
    if (size + width > maxBytes) {
      pieces.push(piece);
      piece = "";
      size = 0;
    }
    piece += char;
    size += width;
  }
  if (piece !== "") pieces.push(piece);
  return pieces;
}

export function fitBytes(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly cut: boolean } {
  if (byteLength(text) <= maxBytes) return { text, cut: false };
  return { text: splitBytes(text, maxBytes)[0] ?? "", cut: true };
}
