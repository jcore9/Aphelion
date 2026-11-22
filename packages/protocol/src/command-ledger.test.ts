import { describe, expect, test } from "vitest";
import { CommandLedger, commandId } from "./index.ts";

const a = commandId.parse("a");
const b = commandId.parse("b");
const c = commandId.parse("c");

function pending() {
  let resolve: (value: string) => void = () => undefined;
  let runs = 0;
  const outcome = new Promise<string>((done) => (resolve = done));
  return {
    apply: () => {
      runs += 1;
      return outcome;
    },
    resolve: (value: string) => {
      resolve(value);
    },
    get runs() {
      return runs;
    },
  };
}

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

  test("a command that throws before it returns a promise is recorded as a failure", async () => {
    const ledger = new CommandLedger<string>({ capacity: 10 });
    let attempts = 0;
    const fail = (): Promise<string> => {
      throw new Error(`attempt ${String(++attempts)}`);
    };
    const first = ledger.run(a, fail);
    await expect(first).rejects.toThrow("attempt 1");
    await expect(ledger.run(a, fail)).rejects.toThrow("attempt 1");
  });

  test("a running command is never forgotten, even past the capacity", async () => {
    const ledger = new CommandLedger<string>({ capacity: 1 });
    const first = pending();
    const second = pending();
    const runA = ledger.run(a, first.apply);
    const runB = ledger.run(b, second.apply);
    const retryA = ledger.run(a, first.apply);
    expect(first.runs).toBe(1);
    first.resolve("a done");
    second.resolve("b done");
    expect(await Promise.all([runA, runB, retryA])).toEqual([
      "a done",
      "b done",
      "a done",
    ]);
  });

  test("once running commands finish, the ledger forgets the oldest down to its capacity", async () => {
    const ledger = new CommandLedger<string>({ capacity: 1 });
    const first = pending();
    const second = pending();
    const runs = [ledger.run(a, first.apply), ledger.run(b, second.apply)];
    first.resolve("a done");
    second.resolve("b done");
    await Promise.all(runs);
    const command = counter();
    expect(await ledger.run(b, command.apply)).toBe("b done");
    expect(await ledger.run(a, command.apply)).toBe("applied 1");
    expect(await ledger.run(c, command.apply)).toBe("applied 2");
  });
});
