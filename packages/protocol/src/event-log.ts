import {
  version,
  type Cursor,
  type EventBody,
  type EventFrame,
  type ResyncFrame,
  type StreamId,
} from "./frames";

export class EventLog {
  readonly #stream: StreamId;
  readonly #capacity: number;
  readonly #kept: EventFrame[] = [];
  #head = 0;

  constructor({ stream, capacity }: { stream: StreamId; capacity: number }) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be a positive integer");
    }
    this.#stream = stream;
    this.#capacity = capacity;
  }

  get head(): Cursor {
    return { stream: this.#stream, seq: this.#head };
  }

  append(event: EventBody): EventFrame {
    this.#head += 1;
    const frame: EventFrame = {
      v: version,
      type: "event",
      seq: this.#head,
      ...event,
    };
    this.#kept.push(frame);
    if (this.#kept.length > this.#capacity) this.#kept.shift();
    return frame;
  }

  resume(
    cursor: Cursor | null,
  ): readonly EventFrame[] | readonly [ResyncFrame] {
    const oldest = this.#head - this.#kept.length;
    if (
      cursor === null ||
      cursor.stream !== this.#stream ||
      cursor.seq > this.#head ||
      cursor.seq < oldest
    ) {
      return [{ v: version, type: "resync", cursor: this.head }];
    }
    return this.#kept.slice(cursor.seq - oldest);
  }
}
