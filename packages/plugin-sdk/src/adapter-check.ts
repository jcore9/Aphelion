import type { AdapterEnvelope } from "./adapter.ts";

/** One rule that a stream broke. */
export interface StreamViolation {
  /** The rule's number, from 1 to 7, as [the bot adapter reference](https://github.com/jcore9/Aphelion/blob/main/docs/reference/bot-adapters.md#rules-a-stream-follows) numbers them. */
  readonly rule: number;
  /** What broke the rule. It names ids and numbers only, never text from the stream. */
  readonly message: string;
}

interface Started {
  readonly turn: string;
  ended: boolean;
}

interface Asked {
  readonly turn: string;
  readonly call: string | null;
  decisions: number;
}

const askKey = (turn: string, request: string) => `${turn}\u0000${request}`;

/**
 * Checks the events of one bot process against the seven rules of [the bot adapter reference](https://github.com/jcore9/Aphelion/blob/main/docs/reference/bot-adapters.md#rules-a-stream-follows).
 * It returns the broken rules, and an empty list when the stream is good. Pass a stream that has finished: a turn without a `turn.end` breaks rule 3.
 */
export function checkStream(
  events: readonly AdapterEnvelope[],
): StreamViolation[] {
  const violations: StreamViolation[] = [];
  const broke = (rule: number, message: string) => {
    violations.push({ rule, message });
  };

  const turnEnds = new Map<string, number>();
  const turnOrder: string[] = [];
  const calls = new Map<string, Started>();
  const asks = new Map<string, Asked>();
  const usages = new Map<string, number>();
  const denies: { readonly turn: string; readonly call: string | null }[] = [];
  let open: string | undefined;
  let expectedSeq = 1;

  for (const { seq, turn, event } of events) {
    if (seq !== expectedSeq) {
      broke(1, `seq ${String(seq)} comes where ${String(expectedSeq)} belongs`);
    }
    expectedSeq = seq + 1;

    if (turn === null) continue;

    const ended = turnEnds.has(turn);
    const lateEnd =
      event.type === "tool.end" && calls.get(event.call)?.turn === turn;
    if (ended && !lateEnd) {
      broke(3, `turn ${turn} has a ${event.type} event after its turn.end`);
    }
    if (!turnOrder.includes(turn)) turnOrder.push(turn);
    if (!lateEnd && !ended) {
      if (open !== undefined && open !== turn) {
        broke(
          2,
          `turn ${turn} has an event while turn ${open} is still running`,
        );
      }
      open = turn;
    }

    switch (event.type) {
      case "turn.end": {
        const count = (turnEnds.get(turn) ?? 0) + 1;
        turnEnds.set(turn, count);
        if (count > 1) broke(3, `turn ${turn} has more than one turn.end`);
        if (open === turn) open = undefined;
        break;
      }
      case "tool.start":
        calls.set(event.call, { turn, ended: false });
        break;
      case "tool.end": {
        const started = calls.get(event.call);
        if (!started) {
          broke(
            4,
            `tool.end for call ${event.call} has no tool.start before it`,
          );
          break;
        }
        if (started.ended) {
          broke(4, `call ${event.call} has more than one tool.end`);
        }
        started.ended = true;
        if (started.turn !== turn) {
          broke(
            2,
            `tool.end for call ${event.call} names turn ${turn}, not the turn that started it`,
          );
        }
        if (
          event.outcome === "denied" &&
          !denies.some(
            (deny) =>
              deny.turn === turn &&
              (deny.call === null || deny.call === event.call),
          )
        ) {
          broke(
            6,
            `call ${event.call} ended denied with no deny decision earlier in turn ${turn}`,
          );
        }
        break;
      }
      case "permission.request": {
        const key = askKey(turn, event.request);
        if (asks.has(key)) {
          broke(5, `request ${event.request} is asked twice in turn ${turn}`);
        }
        asks.set(key, { turn, call: event.call, decisions: 0 });
        break;
      }
      case "permission.decision": {
        const ask = asks.get(askKey(turn, event.request));
        if (!ask) {
          broke(
            5,
            `decision for request ${event.request} has no request before it in turn ${turn}`,
          );
          break;
        }
        ask.decisions += 1;
        if (ask.decisions > 1) {
          broke(5, `request ${event.request} has more than one decision`);
        }
        if (event.decision === "deny") {
          denies.push({ turn, call: ask.call });
        }
        break;
      }
      case "usage": {
        const count = (usages.get(turn) ?? 0) + 1;
        usages.set(turn, count);
        if (count > 1) broke(7, `turn ${turn} has more than one usage`);
        break;
      }
      default:
        break;
    }
  }

  for (const turn of turnOrder) {
    if (!turnEnds.has(turn)) broke(3, `turn ${turn} has no turn.end`);
  }

  const turnEndIndex = new Map<string, number>();
  const decisionIndex = new Map<string, number>();
  events.forEach(({ turn, event }, index) => {
    if (turn === null) return;
    if (event.type === "turn.end" && !turnEndIndex.has(turn)) {
      turnEndIndex.set(turn, index);
    }
    if (event.type === "permission.decision") {
      const key = askKey(turn, event.request);
      if (!decisionIndex.has(key)) decisionIndex.set(key, index);
    }
  });
  for (const [key, ask] of asks) {
    const request = key.slice(key.indexOf("\u0000") + 1);
    if (ask.decisions === 0) {
      broke(5, `request ${request} in turn ${ask.turn} has no decision`);
      continue;
    }
    const decided = decisionIndex.get(key);
    const ended = turnEndIndex.get(ask.turn);
    if (decided !== undefined && ended !== undefined && decided > ended) {
      broke(5, `request ${request} is decided after turn ${ask.turn} ended`);
    }
  }

  return violations;
}
