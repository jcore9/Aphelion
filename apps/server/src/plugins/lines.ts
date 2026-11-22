export type LinePiece =
  | { readonly kind: "line"; readonly text: string }
  | { readonly kind: "too-long" };

const newline = 0x0a;

export class LineSplitter {
  readonly #maxBytes: number;
  readonly #decoder = new TextDecoder();
  #parts: Uint8Array[] = [];
  #size = 0;
  #skipping = false;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  push(chunk: Uint8Array): LinePiece[] {
    const pieces: LinePiece[] = [];
    let start = 0;
    for (let end = chunk.indexOf(newline); end !== -1;) {
      this.#take(chunk.subarray(start, end), pieces);
      const piece = this.#finish();
      if (piece) pieces.push(piece);
      start = end + 1;
      end = chunk.indexOf(newline, start);
    }
    this.#take(chunk.subarray(start), pieces);
    return pieces;
  }

  #take(bytes: Uint8Array, pieces: LinePiece[]): void {
    if (this.#skipping || bytes.length === 0) return;
    if (this.#size + bytes.length > this.#maxBytes) {
      this.#parts = [];
      this.#size = 0;
      this.#skipping = true;
      pieces.push({ kind: "too-long" });
      return;
    }
    this.#parts.push(bytes.slice());
    this.#size += bytes.length;
  }

  #finish(): LinePiece | undefined {
    const skipped = this.#skipping;
    const parts = this.#parts;
    this.#parts = [];
    this.#size = 0;
    this.#skipping = false;
    if (skipped || parts.length === 0) return undefined;
    const bytes = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return { kind: "line", text: this.#decoder.decode(bytes) };
  }
}
