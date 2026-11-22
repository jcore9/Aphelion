import { describe, expect, test } from "vitest";
import { CommandLedger, commandId } from "./index";

const a = commandId.parse("a");
const b = commandId.parse("b");

function counter() {
  let applied = 0;
  return {
    apply: () => Promise.resolve(`applied ${String(++applied)}`),
    get applied() {
      return applied;
    },
  };
}

describe("command ids", () => {
  test("a retried id is applied once and returns the first outcome", async () => {
    const ledger = new CommandLedger<string>({ capacity: 10 });
    const command = counter();
    expect(await ledger.run(a, command.apply)).toBe("applied 1");
    expect(await ledger.run(a, command.apply)).toBe("applied 1");
    expect(command.applied).toBe(1);
  });

  test("different ids are each applied", async () => {
    const ledger = new CommandLedger<string>({ capacity: 10 });
    const command = counter();
    await ledger.run(a, command.apply);
    expect(await ledger.run(b, command.apply)).toBe("applied 2");
  });

  test("a retry that arrives while the first run is in flight waits for it", async () => {
    const ledger = new CommandLedger<string>({ capacity: 10 });
    const command = counter();
    const outcomes = await Promise.all([
      ledger.run(a, command.apply),
      ledger.run(a, command.apply),
    ]);
    expect(outcomes).toEqual(["applied 1", "applied 1"]);
    expect(command.applied).toBe(1);
  });

  test("a retry of a failed command gets the same failure", async () => {
    const ledger = new CommandLedger<string>({ capacity: 10 });
    let attempts = 0;
    const fail = () =>
      Promise.reject(new Error(`attempt ${String(++attempts)}`));
    await expect(ledger.run(a, fail)).rejects.toThrow("attempt 1");
    await expect(ledger.run(a, fail)).rejects.toThrow("attempt 1");
  });

  test("an id older than the capacity is forgotten and applied again", async () => {
    const ledger = new CommandLedger<string>({ capacity: 1 });
    const command = counter();
    await ledger.run(a, command.apply);
    await ledger.run(b, command.apply);
    expect(await ledger.run(a, command.apply)).toBe("applied 3");
  });
});
