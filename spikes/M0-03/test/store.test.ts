import { describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";

describe("bun:sqlite under vitest", () => {
  it("opens a WAL database and round-trips a row", () => {
    const db = new Database(":memory:");
    db.run("create table t (v text)");
    db.run("insert into t values (?)", ["x"]);
    expect(db.query("select v from t").get()).toEqual({ v: "x" });
    expect(typeof Bun.version).toBe("string");
  });
});
