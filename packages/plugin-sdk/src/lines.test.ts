import { expect, test } from "vitest";
import { readLines } from "./lines.ts";

async function collect(chunks: string[], maxBytes: number) {
  const encoder = new TextEncoder();
  async function* source() {
    for (const chunk of chunks) {
      await Promise.resolve();
      yield encoder.encode(chunk);
    }
  }
  let dropped = 0;
  const lines: string[] = [];
  for await (const line of readLines(source(), () => dropped++, maxBytes)) {
    lines.push(line);
  }
  return { lines, dropped };
}

test("joins lines split across chunks and skips empty ones", async () => {
  expect(await collect(['{"a"', ':1}\n\n{"b":2}\n{"c"', ":3}"], 64)).toEqual({
    lines: ['{"a":1}', '{"b":2}', '{"c":3}'],
    dropped: 0,
  });
});

test("drops a line longer than the cap and keeps the lines around it", async () => {
  expect(
    await collect(["short\n", "x".repeat(10), "y".repeat(10), "\nok\n"], 16),
  ).toEqual({
    lines: ["short", "ok"],
    dropped: 1,
  });
});

test("counts bytes, not characters", async () => {
  expect(
    await collect(["é".repeat(8) + "\n", "é".repeat(9) + "\n"], 16),
  ).toEqual({
    lines: ["é".repeat(8)],
    dropped: 1,
  });
});
