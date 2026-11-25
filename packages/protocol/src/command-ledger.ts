import type { CommandId } from "./frames.ts";

export class CommandLedger<Outcome> {
  readonly #capacity: number;
  readonly #outcomes = new Map<CommandId, Promise<Outcome>>();
  readonly #finished: CommandId[] = [];

  constructor({ capacity }: { capacity: number }) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be a positive integer");
    }
    this.#capacity = capacity;
  }

  run(id: CommandId, apply: () => Promise<Outcome>): Promise<Outcome> {
    const known = this.#outcomes.get(id);
    if (known) return known;
    const { promise: outcome, resolve } = Promise.withResolvers<Outcome>();
    this.#outcomes.set(id, outcome);
    this.#trim();
    const finish = () => {
      this.#finished.push(id);
      this.#trim();
    };
    outcome.then(finish, finish);
    resolve(
      new Promise<Outcome>((started) => {
        started(apply());
      }),
    );
    return outcome;
  }

  #trim(): void {
    while (this.#outcomes.size > this.#capacity) {
      const oldest = this.#finished.shift();
      if (oldest === undefined) return;
      this.#outcomes.delete(oldest);
    }
  }
}
