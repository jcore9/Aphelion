import { streamEvent, type StreamEvent } from "@aphelion/plugin-sdk";
import { z } from "zod";
import type { Row } from "../store";

export const eventFormat = 1;

export interface SavedEvent {
  readonly id: string;
  readonly position: number;
  readonly bot: string;
  readonly turn: string | null;
  readonly format: number;
  readonly event: StreamEvent;
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
  format: z.int().positive(),
  kind: z.string(),
  payload: z.string(),
  at: z.int().nonnegative(),
});

export function encodePayload(event: StreamEvent): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(event).filter(([key]) => key !== "type")),
  );
}

const decoders: Readonly<
  Record<number, (kind: string, payload: string) => StreamEvent>
> = {
  1: (kind, payload) =>
    streamEvent.parse({ type: kind, ...(JSON.parse(payload) as object) }),
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
