import type { CommandId } from "./frames.ts";

type Entry<Outcome> = { outcome: Promise<Outcome>; settled: boolean };

export class CommandLedger<Outcome> {
  readonly #capacity: number;
  readonly #entries = new Map<CommandId, Entry<Outcome>>();

  constructor({ capacity }: { capacity: number }) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be a positive integer");
    }
    this.#capacity = capacity;
  }

  run(id: CommandId, apply: () => Promise<Outcome>): Promise<Outcome> {
    const known = this.#entries.get(id);
    if (known) return known.outcome;
    const outcome = new Promise<Outcome>((resolve) => {
      resolve(apply());
    });
    const entry: Entry<Outcome> = { outcome, settled: false };
    this.#entries.set(id, entry);
    this.#trim();
    const settle = () => {
      entry.settled = true;
      this.#trim();
    };
    outcome.then(settle, settle);
    return outcome;
  }

  #trim(): void {
    for (const [id, entry] of this.#entries) {
      if (this.#entries.size <= this.#capacity) return;
      if (entry.settled) this.#entries.delete(id);
    }
  }
}
