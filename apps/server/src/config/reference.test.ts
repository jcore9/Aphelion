import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { jsonSchemaFiles, withFieldReference } from "./reference";

const docs = resolve(import.meta.dirname, "../../../../docs/reference");

test.each(Object.entries(jsonSchemaFiles()))(
  "docs/reference/config/%s matches the schema",
  async (file, content) => {
    await expect(content).toMatchFileSnapshot(join(docs, "config", file));
  },
);

test("docs/reference/config.md lists every field in the schema", async () => {
  const path = join(docs, "config.md");
  const markdown = await readFile(path, "utf8");
  await expect(withFieldReference(markdown)).toMatchFileSnapshot(path);
});
