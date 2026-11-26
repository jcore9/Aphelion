import { z } from "zod";
import type { Row } from "../store";
import { formatOneEvent, type FormatOneEvent } from "./format-1";

export type StoredEvent = FormatOneEvent;

export const eventFormat = 1;

export interface SavedEvent {
  readonly id: string;
  readonly position: number;
  readonly bot: string;
  readonly turn: string | null;
  readonly run: number;
  readonly format: number;
  readonly event: StoredEvent;
  readonly at: number;
}

export class UnreadableEventError extends Error {
  override name = "UnreadableEventError";

  constructor(
    readonly position: number,
    reason: string,
  ) {
    super(`The saved event at position ${String(position)} ${reason}.`);
  }
}

const eventRow = z.object({
  id: z.string(),
  position: z.int().positive(),
  bot: z.string(),
  turn: z.string().nullable(),
  run: z.int().positive(),
  format: z.int().positive(),
  kind: z.string(),
  payload: z.string(),
  at: z.int().nonnegative(),
});

export function encodePayload(event: StoredEvent): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(event).filter(([key]) => key !== "type")),
  );
}

const decoders: Readonly<
  Record<number, (kind: string, payload: string) => StoredEvent>
> = {
  1: (kind, payload) =>
    formatOneEvent.parse({ type: kind, ...(JSON.parse(payload) as object) }),
};

export function decodeEvent(row: Row): SavedEvent {
  const { kind, payload, ...saved } = eventRow.parse(row);
  const decode = decoders[saved.format];
  if (decode === undefined) {
    throw new UnreadableEventError(
      saved.position,
      `has format ${String(saved.format)}, which this server can't read`,
    );
  }
  try {
    return { ...saved, event: decode(kind, payload) };
  } catch {
    throw new UnreadableEventError(
      saved.position,
      `doesn't match format ${String(saved.format)}`,
    );
  }
}
