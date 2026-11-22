import { expect, test } from "vitest";
import { renderSpec, schemaFiles } from "./spec.ts";

test.each(Object.entries(schemaFiles()))(
  "packages/protocol/%s matches the frame schemas",
  async (file, content) => {
    await expect(content).toMatchFileSnapshot(`../${file}`);
  },
);

test("docs/reference/protocol-spec.md matches the frame schemas", async () => {
  await expect(renderSpec()).toMatchFileSnapshot(
    "../../../docs/reference/protocol-spec.md",
  );
});
