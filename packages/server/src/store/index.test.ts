import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { openStore } from ".";
import { migrations } from "./migrations";

test("applies the shipped migrations to a fresh database, then reopens it", () => {
  const dir = mkdtempSync(join(tmpdir(), "aphelion-store-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true });
  });
  const path = join(dir, "aphelion.db");

  openStore(path).close();
  const store = openStore(path);

  expect(store.all("SELECT version, name FROM schema_migrations")).toEqual(
    migrations.map(({ version, name }) => ({ version, name })),
  );
  store.close();
});
