import type { CommandId } from "./frames";

export class CommandLedger<Outcome> {
  readonly #capacity: number;
  readonly #outcomes = new Map<CommandId, Promise<Outcome>>();

  constructor({ capacity }: { capacity: number }) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be a positive integer");
    }
    this.#capacity = capacity;
  }

  run(id: CommandId, apply: () => Promise<Outcome>): Promise<Outcome> {
    const known = this.#outcomes.get(id);
    if (known) return known;
    const outcome = apply();
    this.#outcomes.set(id, outcome);
    if (this.#outcomes.size > this.#capacity) {
      const [oldest] = this.#outcomes.keys();
      if (oldest !== undefined) this.#outcomes.delete(oldest);
    }
    return outcome;
  }
}
